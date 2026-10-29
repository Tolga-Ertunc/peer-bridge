// Claude Code wake adapter for long-lived sessions (advisor / called agent),
// meant for the Monitor tool: prints one line per new peer message and keeps
// running, so the session gets a notification per message without re-arming
// after each one (scripts/claude-wait.mjs exits on the first message instead).
//   node scripts/claude-listen.mjs [--side claude]

import { call } from "../src/broker.mjs";

const args = process.argv.slice(2);
const sideArg = args.indexOf("--side");
const side = sideArg > -1 ? args[sideArg + 1] : "claude";
const widgetId = `listener-${process.pid}`;
const seen = new Set();

await call("report", { side, widgetId, event: "listener-armed", data: { pid: process.pid } });
for (;;) {
  try {
    const { pending } = await call("poll", { side, widgetId, visibility: "background" });
    for (const m of pending.filter((m) => !seen.has(m.id))) {
      seen.add(m.id);
      console.log(`[PEER-BRIDGE] New message ${m.id} from ${m.from} is waiting. Call bridge_receive to read it, then act on it per the bridge task.`);
    }
  } catch {
    // broker owner restarting; the next poll takes over
  }
  await new Promise((r) => setTimeout(r, 1000));
}
