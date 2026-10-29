// Codex / ChatGPT Desktop Stop hook (https://learn.chatgpt.com/docs/hooks).
// When a bridge chat is about to end its turn during an active run, wait for a
// peer message and, if one arrives, block the stop so the model continues with
// a fixed wake prompt instead of going idle.
//
// It reads .bridge/state.json directly instead of calling the broker, because
// the Codex sandbox refuses connections to 127.0.0.1.
//
// Env knobs: PEER_BRIDGE_HOOK_WAIT_S (default 300), PEER_BRIDGE_HOOK_ACTIVE_MIN (default 15).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.PEER_BRIDGE_DIR || path.join(ROOT, ".bridge");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "codex-hook.jsonl");
const SIDE = "openai";
const WAIT_MS = Number(process.env.PEER_BRIDGE_HOOK_WAIT_S || 300) * 1000;
const ACTIVE_MS = Number(process.env.PEER_BRIDGE_HOOK_ACTIVE_MIN || 15) * 60_000;

const t0 = Date.now();
function log(event, data = {}) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n");
  } catch {} // the sandbox may make the project read-only; logging is best effort
}
function done(output) {
  if (output) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
const unread = (s) => (s?.messages || []).filter((m) => m.to === SIDE && !m.readAt);

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {}
const meta = { session: input.session_id, turn: input.turn_id, again: input.stop_hook_active };

// Only chats that joined the bridge. The transcript format is not a stable
// interface, so this is a substring check and nothing more.
let joined = false;
try {
  joined = !!input.transcript_path && fs.readFileSync(input.transcript_path, "utf8").includes("bridge_join");
} catch {}
if (!joined) done();

// Only during an active run: some bridge traffic within the last ACTIVE_MS.
const state = readState();
const lastTs = Math.max(0, ...(state?.messages || []).map((m) => m.readAt || m.ts));
if (!unread(state).length && Date.now() - lastTs > ACTIVE_MS) {
  log("skip-idle-run", { ...meta, lastTs });
  done();
}

log("wait", { ...meta, waitMs: WAIT_MS });
while (Date.now() - t0 < WAIT_MS) {
  const pending = unread(readState());
  if (pending.length) {
    const ids = pending.map((m) => m.id).join(", ");
    const from = [...new Set(pending.map((m) => m.from))].join(", ");
    log("block", { ...meta, ids, waitedMs: Date.now() - t0 });
    done({
      decision: "block",
      reason: `[PEER-BRIDGE] New message ${ids} from ${from} is waiting. Call bridge_receive to read it, then act on it per the bridge task.`,
    });
  }
  await new Promise((r) => setTimeout(r, 1000));
}
log("timeout", { ...meta, waitedMs: Date.now() - t0 });
done();
