// Identify which host chat made a tool call.
// - Claude Code (user-scope server): each session spawns its own server with
//   the session's environment, so CLAUDE_CODE_SESSION_ID is inherited.
//   Fallback when it isn't (other launchers, scrubbed env): Claude Code puts
//   `claudecode/toolUseId` in `_meta`, and the tool_use block carrying that id
//   is already in the session transcript (<claude config>/projects/<project>/
//   <sessionId>.jsonl) while the tool runs. (Claude Desktop's own MCP config
//   proxies servers without either, hence install.mjs uses user scope.)
// - Codex sends `threadId` and `sessionId` in `_meta` itself.

import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir } from "./platform.mjs";

const CLAUDE_PROJECTS = path.join(claudeConfigDir(), "projects");
const RECENT_MS = 10 * 60_000;
const TAIL_BYTES = 512 * 1024;

function tail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function recentTranscripts() {
  const now = Date.now();
  const out = [];
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = path.join(CLAUDE_PROJECTS, dir.name);
    for (const f of fs.readdirSync(base)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(base, f);
      const mtime = fs.statSync(file).mtimeMs;
      if (now - mtime < RECENT_MS) out.push({ file, mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((t) => t.file);
}

export async function claudeSessionFor(toolUseId) {
  if (!toolUseId) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const file of recentTranscripts()) {
      if (tail(file).includes(`"${toolUseId}"`)) return path.basename(file, ".jsonl");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Session id inherited from the spawning Claude Code session
export function inheritedSession() {
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

export async function identify(side, extra) {
  const meta = extra?._meta ?? {};
  const caller = { metaKeys: Object.keys(meta) };
  if (side === "claude") {
    caller.toolUseId = meta["claudecode/toolUseId"] ?? null;
    caller.claudeSessionId = inheritedSession() ?? (await claudeSessionFor(caller.toolUseId));
    caller.via = inheritedSession() ? "env" : caller.claudeSessionId ? "transcript" : null;
  } else {
    // Codex sends the calling thread directly
    caller.threadId = meta.threadId ?? null;
    caller.sessionId = meta.sessionId ?? null;
  }
  return caller;
}

// The calling chat as a broker endpoint ({ app, id }), or null if unknown.
// Codex hooks get the thread id as session_id, so both key on the same id.
export async function endpointOf(side, extra) {
  const c = await identify(side, extra);
  const id = side === "claude" ? c.claudeSessionId : (c.threadId ?? c.sessionId);
  return id ? { app: side, id } : null;
}
