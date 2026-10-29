// One timed wake cycle against a real app: send a labelled message to a side,
// then follow the event log until the peer reads it (and optionally replies).
//   node scripts/probe.mjs --to openai --label T4 [--delay 20] [--timeout 300] [--no-reply]
//
// --delay gives you time to put the app in the state under test (minimize,
// start a long answer, switch chat) before the message goes out.

import fs from "node:fs";
import { call, EVENTS_FILE, SIDES } from "../src/broker.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const to = arg("--to");
const label = arg("--label", "probe");
const delay = Number(arg("--delay", 0));
const timeout = Number(arg("--timeout", 300));
const wantReply = !process.argv.includes("--no-reply");
if (!SIDES.includes(to)) {
  console.error(`usage: probe.mjs --to ${SIDES.join("|")} --label T4 [--delay s] [--timeout s] [--no-reply]`);
  process.exit(2);
}
const from = SIDES.find((s) => s !== to);

for (let s = delay; s > 0; s--) {
  process.stdout.write(`\rsending in ${s}s… `);
  await new Promise((r) => setTimeout(r, 1000));
}
const text = wantReply
  ? `${label} probe. Reply via bridge_send with exactly: "${label} pong" and nothing else. Take no other action.`
  : `${label} probe. Just acknowledge in this chat; do not reply through the bridge.`;
const sent = await call("send", { from, to, text });
const t0 = Date.now();
console.log(`\n${label}: sent ${sent.id} ${from} → ${to}`);

const offset = fs.statSync(EVENTS_FILE).size;
const seen = new Set();
const rel = (ts) => `+${((Date.parse(ts) - t0) / 1000).toFixed(1)}s`.padStart(8);
let replyId = null;

while (Date.now() - t0 < timeout * 1000) {
  await new Promise((r) => setTimeout(r, 1000));
  const fd = fs.openSync(EVENTS_FILE, "r");
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
    if (seen.has(line)) continue;
    seen.add(line);
    const e = JSON.parse(line);
    if (e.op === "claim" && e.id === sent.id) console.log(`${rel(e.ts)}  panel ${e.widgetId} claimed the wake-up`);
    if (e.event === "wake-result" && e.data?.id === sent.id)
      console.log(`${rel(e.ts)}  ui/message ${e.data.ok ? "OK" : "FAILED"} (${e.data.ms} ms, vis=${e.data.visibility}, focus=${e.data.focused}) ${e.data.error ?? ""}`);
    if (e.event === "waiter-fired" && e.side === to) console.log(`${rel(e.ts)}  claude-wait fired`);
    if (e.event === "teardown" && e.side === to) console.log(`${rel(e.ts)}  panel ${e.widgetId} torn down`);
    if (e.op === "receive" && e.ids?.includes(sent.id)) {
      console.log(`${rel(e.ts)}  ${to} model read it`);
      if (!wantReply) process.exit(0);
    }
    if (e.op === "send" && e.from === to && !replyId) {
      replyId = e.id;
      console.log(`${rel(e.ts)}  ${to} replied (${e.id})`);
    }
  }
  if (replyId) {
    // Consume the pong so it doesn't wake the other app.
    const r = await call("receive", { side: from });
    const pong = r.messages.find((m) => m.id === replyId);
    console.log(`reply text: ${JSON.stringify(pong?.text)}`);
    process.exit(0);
  }
}
console.log(`${label}: timed out after ${timeout}s`);
process.exit(1);
