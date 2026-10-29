// Exercises scripts/codex-stop-hook.mjs against a throwaway state dir.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-hook-"));
const hook = path.resolve(import.meta.dirname, "codex-stop-hook.mjs");
const joined = path.join(dir, "joined.jsonl");
const other = path.join(dir, "other.jsonl");
fs.writeFileSync(joined, '{"tool":"bridge_join"}\n');
fs.writeFileSync(other, '{"tool":"something_else"}\n');

const now = Date.now();
const msg = (id, ts, readAt) => ({ id, from: "claude", to: "openai", text: id, ts, readAt });
const setState = (messages) => fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ runId: "r", seq: 9, widgets: {}, messages }));

function run(transcript, waitS = 3) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [hook], { env: { ...process.env, PEER_BRIDGE_DIR: dir, PEER_BRIDGE_HOOK_WAIT_S: String(waitS) } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "s1", turn_id: "t1", stop_hook_active: false, cwd: ".", model: "x", permission_mode: "default", last_assistant_message: null, transcript_path: transcript }));
  });
}

setState([msg("m1", now - 3_600_000, now - 3_600_000)]);
let r = await run(other);
assert.equal(r.out, "");
assert.ok(r.ms < 1000, "non-bridge chat must not wait");
console.log(`1 non-bridge chat: no output, ${r.ms} ms`);

r = await run(joined);
assert.equal(r.out, "");
assert.ok(r.ms < 1000, "idle run must not wait");
console.log(`2 bridge chat, idle run: no output, ${r.ms} ms`);

setState([msg("m1", now, now)]);
r = await run(joined);
assert.equal(r.out, "");
assert.ok(r.ms >= 2900, "active run waits the full window");
console.log(`3 bridge chat, active run, no message: no output after ${r.ms} ms`);

setTimeout(() => setState([msg("m1", now, now), msg("m2", Date.now(), null)]), 1500);
r = await run(joined, 10);
const out = JSON.parse(r.out);
assert.equal(out.decision, "block");
assert.match(out.reason, /New message m2 from claude/);
assert.ok(r.ms < 4000);
console.log(`4 bridge chat, message arrives: block after ${r.ms} ms → ${out.reason}`);

console.log("hook log:\n" + fs.readFileSync(path.join(dir, "codex-hook.jsonl"), "utf8"));
