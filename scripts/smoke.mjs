// Spawns two server processes (claude + openai) against a throwaway broker
// and runs the whole message path the panels and models would use.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-smoke-"));
const env = { ...process.env, PEER_BRIDGE_DIR: dir, PEER_BRIDGE_PORT: "7499" };
const server = path.resolve(import.meta.dirname, "../src/server.mjs");

async function connect(side) {
  const client = new Client({ name: `smoke-${side}`, version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, "--side", side], env, stderr: "ignore" }));
  return client;
}
const json = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

const claude = await connect("claude");
const openai = await connect("openai");

const { tools } = await claude.listTools();
const join = tools.find((t) => t.name === "bridge_join");
assert.equal(join._meta.ui.resourceUri, "ui://peer-bridge/panel.html");
assert.deepEqual(tools.find((t) => t.name === "bridge_poll")._meta.ui.visibility, ["app"]);

const res = await claude.readResource({ uri: "ui://peer-bridge/panel.html" });
assert.equal(res.contents[0].mimeType, "text/html;profile=mcp-app");
assert.match(res.contents[0].text, /ui\/message/);

assert.equal(json(await call(claude, "bridge_join")).side, "claude");

// openai panel heartbeat, nothing pending yet
const first = json(await call(openai, "bridge_poll", { widgetId: "wA", visibility: "visible" }));
assert.equal(first.side, "openai");
assert.deepEqual(first.pending, []);

// claude model sends; broker stamps from=claude
await call(claude, "bridge_send", { text: "please review: 2+2=5" });
const polled = json(await call(openai, "bridge_poll", { widgetId: "wA" }));
assert.deepEqual(polled.pending, [{ id: "m1", from: "claude" }]);

// two panels race for the same wake-up: only one wins
assert.equal(json(await call(openai, "bridge_claim", { widgetId: "wA", id: "m1" })).ok, true);
assert.equal(json(await call(openai, "bridge_claim", { widgetId: "wB", id: "m1" })).ok, false);
assert.deepEqual(json(await call(openai, "bridge_poll", { widgetId: "wB" })).pending, []);
await call(openai, "bridge_report", { widgetId: "wA", event: "wake-result", data: { id: "m1", ok: true, ms: 12 } });

// openai model reads it, wrapped in the envelope
const recv = (await call(openai, "bridge_receive")).content[0].text;
assert.match(recv, /\[PEER from=claude id=m1 run=r\w+\]\nplease review: 2\+2=5\n\[\/PEER\]/);
assert.match((await call(openai, "bridge_receive")).content[0].text, /No unread/);

// reply goes back to claude
await call(openai, "bridge_send", { text: "2+2=4" });
assert.deepEqual(json(await call(claude, "bridge_poll", { widgetId: "wC" })).pending, [{ id: "m2", from: "openai" }]);

// closing the owning process hands the broker to the survivor
await claude.close();
assert.match((await call(openai, "bridge_status")).content[0].text, /"messages": 2/);

await openai.close();
const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
assert.ok(events.some((e) => e.event === "wake-result"));
console.log(`smoke ok — ${events.length} events in ${dir}`);
