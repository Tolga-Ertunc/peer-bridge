// Minimal MCP Apps host for checking the panel in a plain browser before
// trying the real apps. It renders the panel in a sandboxed iframe, proxies
// tools/call to a real server process and shows ui/message as chat bubbles.
//   node scripts/dev-host.mjs --side claude   → http://127.0.0.1:7460

import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sideIdx = process.argv.indexOf("--side");
const side = sideIdx > -1 ? process.argv[sideIdx + 1] : "claude";
const port = Number(process.env.DEV_HOST_PORT || 7460);

const client = new Client({ name: "dev-host", version: "0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.resolve(import.meta.dirname, "../src/server.mjs"), "--side", side], stderr: "inherit" }),
);
await client.callTool({ name: "bridge_join", arguments: {} });
const panel = (await client.readResource({ uri: "ui://peer-bridge/panel.html" })).contents[0].text;

const page = `<!doctype html><meta charset="utf-8"><title>Dev host</title>
<style>body{font:14px system-ui;margin:16px;max-width:760px}iframe{width:100%;border:1px solid #ccc;border-radius:8px;height:420px}
.msg{background:#eef;border-radius:8px;padding:6px 10px;margin:6px 0;font-family:monospace;white-space:pre-wrap}</style>
<h3>Dev host · side=${side}</h3>
<label><input type="checkbox" id="deny"> host rejects ui/message</label>
<iframe id="f" sandbox="allow-scripts"></iframe><h4>chat (ui/message received)</h4><div id="chat"></div>
<script>
const f = document.getElementById("f");
f.srcdoc = ${JSON.stringify(panel).replace(/</g, "\\u003c")};
const reply = (id, body) => f.contentWindow.postMessage({ jsonrpc: "2.0", id, ...body }, "*");
window.addEventListener("message", async (ev) => {
  if (ev.source !== f.contentWindow) return;
  const m = ev.data; if (!m || m.jsonrpc !== "2.0" || !m.method) return;
  if (m.method === "ui/initialize") return reply(m.id, { result: { protocolVersion: "2026-01-26", hostInfo: { name: "dev-host", version: "0" },
    hostCapabilities: { message: { text: {} }, serverTools: {} }, hostContext: { theme: "light", displayMode: "inline", platform: "web" } } });
  if (m.method === "tools/call") {
    const r = await fetch("/tools/call", { method: "POST", body: JSON.stringify(m.params) }).then((r) => r.json());
    return reply(m.id, r.error ? { error: { code: -32000, message: r.error } } : { result: r });
  }
  if (m.method === "ui/message") {
    const d = document.createElement("div"); d.className = "msg"; d.textContent = m.params.content.map((c) => c.text).join("\\n");
    document.getElementById("chat").prepend(d);
    return reply(m.id, { result: document.getElementById("deny").checked ? { isError: true } : {} });
  }
  if (m.id !== undefined) reply(m.id, { result: {} });
});
</script>`;

http
  .createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/tools/call") {
      let body = "";
      for await (const c of req) body += c;
      try {
        res.end(JSON.stringify(await client.callTool(JSON.parse(body))));
      } catch (e) {
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  })
  .listen(port, "127.0.0.1", () => console.log(`dev host for side=${side} on http://127.0.0.1:${port}`));
