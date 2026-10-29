// End-to-end test of links and hooks against a throwaway data dir: the broker
// runs in this process, src/hook.mjs runs as a real subprocess with hook JSON
// on stdin, Codex delivery is faked (PEER_BRIDGE_FAKE_CODEX).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-link-"));
Object.assign(process.env, { PEER_BRIDGE_DIR: dir, PEER_BRIDGE_PORT: "7498", PEER_BRIDGE_FAKE_CODEX: "1" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0. a stale owner (older protocol, e.g. a helper left over from before an
// update) steps down when a newer client calls, and the client takes over
const brokerUrl = new URL("../src/broker.mjs", import.meta.url).href;
const stale = spawn(process.execPath, ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");console.log("owner");setInterval(()=>{},1000);`], {
  env: { ...process.env, PEER_BRIDGE_TEST_PROTOCOL: "1" },
});
await new Promise((r) => stale.stdout.once("data", r));
const { call } = await import("../src/broker.mjs");
await call("link_create", { primary: { app: "claude", id: "probe" } }); // op the stale owner wouldn't run new code for
await call("link_close", { endpoint: { app: "claude", id: "probe" } });
stale.kill();
assert.ok(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").includes('"op":"broker-step-down"'));
console.log("0 stale broker owner stepped down, newer client took over");

const hook = path.resolve(import.meta.dirname, "../src/hook.mjs");
const events = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(50);
  }
}

function runHook(app, event, input, { killAfter } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [hook, "--app", app, "--event", event], { env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    if (killAfter) setTimeout(() => p.kill(), killAfter);
    p.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify({ hook_event_name: event, cwd: ".", ...input }));
  });
}

const CLAUDE = { app: "claude", id: "claude-session-1" };
const GPT = { app: "openai", id: "gpt-thread-1" };
const CLAUDE2 = { app: "claude", id: "claude-session-2" };

// 1. unlinked chats: hooks exit at once, nothing queued
let r = await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "hi" });
assert.equal(r.code, 0);
assert.equal(r.out, "");
r = await runHook("claude", "listen", { session_id: CLAUDE.id });
assert.equal(r.code, 0);
assert.equal(fs.readdirSync(path.join(dir, "outbox")).length, 0);
console.log(`1 unlinked: stop/listen exit 0 at once (${r.ms} ms)`);

// 2. Claude primary, GPT advisor: Stop queues a review, GPT gets it via the thread queue
const link = await call("link_create", { primary: CLAUDE, advisor: GPT });
r = await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Refactored the parser." });
assert.equal(r.code, 0);
assert.equal(r.out, "", "Stop must not block or print");
assert.ok(r.ms < 1500, `stop hook took ${r.ms} ms`);
const req = await until(() => state().messages.find((m) => m.kind === "review-request"));
assert.deepEqual(req.toEndpoint, GPT);
assert.match(req.text, /Refactored the parser/);
await until(() => events().find((e) => e.op === "fake-codex-deliver" && e.threadId === GPT.id));
console.log(`2 Claude→GPT review request ${req.id} queued by Stop (${r.ms} ms), delivered to the GPT thread`);

// 3. GPT receives and advises a concern → Claude's listener wakes it (exit 2)
const got = await call("receive", { side: "openai", endpoint: GPT });
assert.equal(got.messages[0].kind, "review-request");
const listener = runHook("claude", "listen", { session_id: CLAUDE.id });
await sleep(1500);
const adv = await call("advise", { endpoint: GPT, verdict: "incorrect", severity: "concern", note: "Parser drops the last token." });
assert.equal(adv.delivered, "now");
r = await listener;
assert.equal(r.code, 2, "listener must exit 2 to wake Claude");
assert.match(r.err, /flagged your last turn/);
console.log(`3 concern → Claude listener exited 2: ${r.err.split("\n")[0].slice(0, 90)}…`);

// 4. the follow-up turn the advisory triggered is not sent back for review
const before = state().messages.length;
await call("receive", { side: "claude", endpoint: CLAUDE });
await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Fixed the last token." });
await until(() => events().some((e) => e.op === "turn_end" && e.skipped === "advisory follow-up"));
assert.equal(state().messages.length, before);
console.log("4 advisory follow-up turn not re-reviewed (no cascade)");

// 5. nits wait for the next prompt, once; duplicates are dropped
await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Added tests." });
await until(() => state().messages.length === before + 1);
await call("advise", { endpoint: GPT, verdict: "correct", severity: "nit", note: "Name the test after the bug." });
const dup = await call("advise", { endpoint: GPT, verdict: "correct", severity: "nit", note: "Name the test after the bug." });
assert.ok(dup.dup);
r = await runHook("claude", "prompt", { session_id: CLAUDE.id, prompt: "next" });
const ctx = JSON.parse(r.out).hookSpecificOutput;
assert.equal(ctx.hookEventName, "UserPromptSubmit");
assert.match(ctx.additionalContext, /Name the test after the bug/);
await until(() => state().notes.every((n) => n.deliveredAt));
r = await runHook("claude", "prompt", { session_id: CLAUDE.id, prompt: "again" });
assert.equal(r.out, "");
console.log("5 nit delivered once with the next prompt, duplicate dropped");

// 6. reverse direction: GPT primary, Claude advisor via join code
await call("link_close", { endpoint: CLAUDE });
const l2 = await call("link_create", { primary: GPT });
assert.ok(l2.joinCode);
await call("link_join", { code: l2.joinCode, endpoint: CLAUDE2 });
const advisorListener = runHook("claude", "listen", { session_id: CLAUDE2.id });
await sleep(1200);
r = await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t9", last_assistant_message: "Wrote the migration." });
assert.equal(r.out, "");
r = await advisorListener;
assert.equal(r.code, 2);
assert.match(r.err, /Review request/);
await call("advise", { endpoint: CLAUDE2, verdict: "incorrect", severity: "blocker", note: "Migration is not reversible." });
await until(() => events().some((e) => e.op === "fake-codex-deliver" && /flagged your last turn/.test(e.text)));
console.log("6 GPT primary → Claude advisor (join code): listener woke Claude, blocker queued back to the GPT thread");

// 7. one listener per session: a newer one supersedes the older
await call("receive", { side: "claude", endpoint: CLAUDE2 });
const older = runHook("claude", "listen", { session_id: CLAUDE2.id });
await sleep(800);
const newer = runHook("claude", "listen", { session_id: CLAUDE2.id }, { killAfter: 3000 });
r = await older;
assert.equal(r.code, 0, "older listener must step aside quietly");
await newer;
console.log("7 newer listener superseded the older one (exit 0, no wake)");

// 8. unlink: listener and hooks go quiet
await call("link_close", { endpoint: GPT });
r = await runHook("claude", "listen", { session_id: CLAUDE2.id });
assert.equal(r.code, 0);
console.log(`8 after unlink the listener exits at once (${r.ms} ms)`);

// 9. owner dies while idle: a surviving server's keepOwner ping takes over and
// ingests the hook's request (this process stops owning by exiting the child
// test below, so run it on a fresh port + dir)
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-owner-"));
  const env2 = { ...process.env, PEER_BRIDGE_DIR: dir2, PEER_BRIDGE_PORT: "7497" };
  const proc = (code) => spawn(process.execPath, ["--input-type=module", "-e", code], { env: env2 });
  const ownerA = proc(`const b=await import(${JSON.stringify(brokerUrl)});await b.call("link_create",{primary:{app:"claude",id:"S9"},advisor:{app:"claude",id:"A9"}});console.log("ready");setInterval(()=>{},1000);`);
  await new Promise((r) => ownerA.stdout.once("data", r));
  const serverB = proc(`const b=await import(${JSON.stringify(brokerUrl)});await b.call("ping");b.keepOwner(500);console.log("ready");setInterval(()=>{},1000);`);
  await new Promise((r) => serverB.stdout.once("data", r));
  ownerA.kill();
  await sleep(300);
  const t0 = Date.now();
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [hook, "--app", "claude", "--event", "stop"], { env: env2 });
    p.on("close", resolve);
    p.stdin.end(JSON.stringify({ session_id: "S9", last_assistant_message: "x" }));
  });
  const ev = () => fs.readFileSync(path.join(dir2, "events.jsonl"), "utf8");
  const end = Date.now() + 4000;
  while (!ev().includes('"kind":"review-request"') && Date.now() < end) await sleep(50);
  serverB.kill();
  assert.ok(ev().includes('"kind":"review-request"'), "surviving server must take over and ingest");
  console.log(`9 owner died while idle: surviving server took over, request ingested in ${Date.now() - t0} ms`);
}

console.log("\nhooks log:\n" + fs.readFileSync(path.join(dir, "hooks.jsonl"), "utf8"));
process.exit(0);
