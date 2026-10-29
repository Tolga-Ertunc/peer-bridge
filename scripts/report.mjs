// Summarise .bridge/events.jsonl into the numbers the test matrix needs:
// per panel — host, ui/message support, heartbeat gaps by visibility, and
// every ui/message attempt with its outcome.

import fs from "node:fs";
import { EVENTS_FILE } from "../src/broker.mjs";

const sinceIdx = process.argv.indexOf("--since");
const since = sinceIdx > -1 ? Date.now() - Number(process.argv[sinceIdx + 1]) * 60_000 : 0;

const events = fs
  .readFileSync(EVENTS_FILE, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((e) => Date.parse(e.ts) >= since);

const panels = new Map();
const panel = (id, side) => {
  if (!panels.has(id)) panels.set(id, { side, host: "?", message: null, polls: 0, gaps: {}, attempts: [], other: [] });
  return panels.get(id);
};

for (const e of events) {
  if (!e.widgetId) continue;
  const p = panel(e.widgetId, e.side);
  if (e.op === "poll") {
    p.polls++;
    const key = `${e.visibility}${e.focused ? "+focus" : ""}`;
    p.gaps[key] = Math.max(p.gaps[key] || 0, e.gapMs || 0);
  } else if (e.event === "init") {
    p.host = `${e.data?.hostInfo?.name ?? "?"} ${e.data?.hostInfo?.version ?? ""}`.trim();
    p.message = !!e.data?.hostCapabilities?.message;
  } else if (["wake-result", "manual-test", "delayed-test"].includes(e.event)) {
    const d = e.data || {};
    p.attempts.push(
      `${e.ts.slice(11, 19)} ${e.event.padEnd(12)} ${d.ok ? "OK  " : "FAIL"} ${String(d.ms ?? "?").padStart(5)} ms  vis=${d.visibility} focus=${d.focused} ${d.error ?? ""}`,
    );
  } else if (["teardown", "visibility"].includes(e.event)) {
    p.other.push(`${e.ts.slice(11, 19)} ${e.event} ${JSON.stringify(e.data ?? {})}`);
  }
}

if (!panels.size) console.log("no panel events yet");
for (const [id, p] of panels) {
  console.log(`\n=== panel ${id} · side=${p.side} · host=${p.host} · ui/message cap=${p.message}`);
  console.log(`polls: ${p.polls} · max gap by state (s): ${Object.entries(p.gaps).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}`).join("  ") || "–"}`);
  for (const a of p.attempts) console.log("  " + a);
  for (const o of p.other.slice(-10)) console.log("  · " + o);
}
