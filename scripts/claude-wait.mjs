// Claude Code wake adapter. Run as a background Bash command inside the Claude
// Code session; it exits as soon as a peer message for that side is unread,
// and the session's background-task notification starts a new turn.
//   node scripts/claude-wait.mjs [--side claude] [--max-min 120]

import { call } from "../src/broker.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const side = arg("--side", "claude");
const deadline = Date.now() + Number(arg("--max-min", 120)) * 60_000;

await call("report", { side, widgetId: "claude-wait", event: "waiter-armed", data: { pid: process.pid } });
while (Date.now() < deadline) {
  const st = await call("status");
  if (st.unread[side] > 0) {
    await call("report", { side, widgetId: "claude-wait", event: "waiter-fired", data: { unread: st.unread[side] } });
    console.log(`[PEER-BRIDGE] ${st.unread[side]} unread peer message(s) for ${side} (run ${st.runId}). Call bridge_receive, act on it, then re-arm this waiter.`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("[PEER-BRIDGE] waiter timed out with no message.");
process.exit(1);
