// Inject a message into the bridge as if it came from the other side, so one
// app can be tested on its own.
//   node scripts/send.mjs --to claude "Review this: ..."
//   node scripts/send.mjs --status | --reset

import { call, SIDES } from "../src/broker.mjs";

const args = process.argv.slice(2);
if (args.includes("--status")) {
  console.log(JSON.stringify(await call("status"), null, 2));
} else if (args.includes("--reset")) {
  console.log(await call("reset"));
} else {
  const toIdx = args.indexOf("--to");
  const to = toIdx > -1 ? args.splice(toIdx, 2)[1] : null;
  const text = args.join(" ");
  if (!SIDES.includes(to) || !text) {
    console.error(`usage: send.mjs --to ${SIDES.join("|")} <text>   |   --status   |   --reset`);
    process.exit(2);
  }
  const from = SIDES.find((s) => s !== to);
  console.log(await call("send", { from, to, text }));
}
process.exit(0);
