// Shared message broker for the peer bridge.
//
// Each app (Claude Desktop, ChatGPT Desktop) launches its own stdio MCP server
// process. Whichever process starts first binds 127.0.0.1:PORT and owns the
// state; the others talk to it over HTTP. If the owner exits, the next request
// from a client promotes that client to owner (state is persisted to disk).
//
// Hooks never talk to the broker over the network (Codex sandboxes localhost):
// they read state.json and drop request files into outbox/, which the owner
// ingests. A link pairs a primary chat with an advisor chat; endpoints are
// { app: "claude"|"openai", id: Claude session id | Codex thread id }.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./platform.mjs";

export const DATA_DIR = dataDir();
export const STATE_FILE = path.join(DATA_DIR, "state.json");
export const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
export const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
export const LISTENERS_DIR = path.join(DATA_DIR, "listeners");
const TOKEN_FILE = path.join(DATA_DIR, "token");
const PORT = Number(process.env.PEER_BRIDGE_PORT || 7457);
// Bumped whenever ops change. An owner running older code (a long-lived helper
// left over from before an update) steps down when a newer client calls.
export const PROTOCOL = Number(process.env.PEER_BRIDGE_TEST_PROTOCOL || 2);

export const SIDES = ["claude", "openai"];
const MAX_MESSAGES_PER_RUN = 200; // runaway-loop guard
const MAX_TEXT = 20_000;
const CLAIM_TTL_MS = 30_000;
const SEVERITIES = ["none", "nit", "concern", "blocker"];

for (const d of [DATA_DIR, OUTBOX_DIR, LISTENERS_DIR]) fs.mkdirSync(d, { recursive: true });

const sameEndpoint = (a, b) => !!a && !!b && a.app === b.app && a.id === b.id;

// Read-only view of the broker state for hooks (no broker process needed)
export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export const activeLinks = (state) => Object.values(state?.links ?? {}).filter((l) => l.active);

// Drop a request for the broker owner; atomic so the owner never reads half a file
export function writeOutbox(op, args) {
  const name = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}.json`;
  const tmp = path.join(OUTBOX_DIR, name + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify({ op, args }));
  fs.renameSync(tmp, path.join(OUTBOX_DIR, name));
}

// Messages that should wake a Claude endpoint (read by its listener hook)
export function pendingFor(state, endpoint) {
  return (state?.messages ?? []).filter((m) => sameEndpoint(m.toEndpoint, endpoint) && !m.readAt && (m.wakes ?? 0) < 2);
}

const OUTBOX_OPS = new Set(["turn_end", "notes_ack", "wake_ack"]);

function token() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    const t = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(TOKEN_FILE, t);
    return t;
  }
}

function freshState() {
  return { runId: "r" + Date.now().toString(36), seq: 0, messages: [], widgets: {}, links: {}, linkSeq: 0, notes: [] };
}

function logEvent(event) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

export const listenerFile = (endpoint) => path.join(LISTENERS_DIR, `${endpoint.app}-${endpoint.id.replace(/[^\w.-]/g, "_")}.json`);

function listenerAlive(endpoint) {
  try {
    const l = JSON.parse(fs.readFileSync(listenerFile(endpoint), "utf8"));
    return Date.now() - l.beat < 30_000 ? l : null;
  } catch {
    return null;
  }
}

// What the woken chat sees; self-contained so it works after compaction
function wakeText(m) {
  if (m.kind === "review-request")
    return `[PEER-BRIDGE] Review request ${m.id} (link ${m.linkId}) from ${m.from} is waiting. Call bridge_receive to read it, review it as this link's advisor, then call bridge_advise with your verdict.`;
  if (m.kind === "advisory")
    return `[PEER-BRIDGE] Your advisor (${m.from}) flagged your last turn: ${m.id} (link ${m.linkId}). Call bridge_receive to read it, then address it or explain why not.`;
  return `[PEER-BRIDGE] New message ${m.id} from ${m.from} is waiting. Call bridge_receive to read it, then act on it per the bridge task.`;
}
export { wakeText };

async function deliverToCodex(threadId, text) {
  if (process.env.PEER_BRIDGE_FAKE_CODEX) {
    logEvent({ op: "fake-codex-deliver", threadId, text });
    return;
  }
  const { sendToThread } = await import("./codex.mjs");
  await sendToThread(threadId, text);
}

// ---------------------------------------------------------------- owner side

class BrokerState {
  constructor() {
    try {
      this.s = { ...freshState(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
    } catch {
      this.s = freshState();
    }
  }

  save() {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.s, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }

  handle(op, a) {
    const fn = this["op_" + op];
    if (!fn) throw new Error(`unknown op: ${op}`);
    const result = fn.call(this, a);
    this.save();
    this.dispatch();
    return result;
  }

  // Requests hooks left in outbox/ (only the ops hooks are allowed to make)
  ingestOutbox() {
    let files;
    try {
      files = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const f of files) {
      const file = path.join(OUTBOX_DIR, f);
      try {
        const { op, args } = JSON.parse(fs.readFileSync(file, "utf8"));
        if (OUTBOX_OPS.has(op)) this.handle(op, args ?? {});
        else logEvent({ op: "outbox-rejected", file: f, requested: op });
      } catch (e) {
        logEvent({ op: "outbox-error", file: f, error: String(e.message || e) });
      }
      fs.rmSync(file, { force: true });
    }
  }

  // Codex endpoints are woken through the app's thread queue; Claude endpoints
  // by their listener hook, which watches state.json itself
  dispatch() {
    for (const m of this.s.messages) {
      // a "sending" left behind by an owner that died mid-send is retried
      const stuck = m.dispatch?.state === "sending" && Date.now() - m.dispatch.at > 60_000;
      if (m.toEndpoint?.app !== "openai" || (m.dispatch && !stuck)) continue;
      m.dispatch = { state: "sending", at: Date.now() };
      deliverToCodex(m.toEndpoint.id, wakeText(m)).then(
        () => {
          m.dispatch = { state: "sent", at: Date.now() };
          logEvent({ op: "dispatch", id: m.id, to: m.toEndpoint, ok: true });
          this.save();
        },
        (e) => {
          m.dispatch = { state: "error", at: Date.now(), error: String(e.message || e) };
          logEvent({ op: "dispatch", id: m.id, to: m.toEndpoint, ok: false, error: m.dispatch.error });
          this.save();
        },
      );
    }
  }

  op_status() {
    const s = this.s;
    return {
      runId: s.runId,
      messages: s.messages.length,
      maxMessages: MAX_MESSAGES_PER_RUN,
      unread: Object.fromEntries(SIDES.map((x) => [x, s.messages.filter((m) => m.to === x && !m.readAt).length])),
      links: Object.values(s.links).map((l) => ({
        ...l,
        advisories: l.advisories?.length ?? 0,
        // Claude endpoints need a live listener hook to be woken
        listening: Object.fromEntries(
          ["primary", "advisor"].filter((r) => l[r]?.app === "claude").map((r) => [r, !!listenerAlive(l[r])]),
        ),
      })),
      widgets: Object.entries(s.widgets).map(([id, w]) => ({ id, ...w })),
    };
  }

  // ------------------------------------------------------------- links

  linkFor(role, endpoint) {
    return Object.values(this.s.links).find((l) => l.active && sameEndpoint(l[role], endpoint));
  }

  // One active link per primary; advisor may be bound now or later via join code
  op_link_create({ primary, advisor, mode = "advisor", name }) {
    if (!primary?.app || !primary?.id) throw new Error("primary endpoint unknown (caller identity missing)");
    for (const l of Object.values(this.s.links)) if (l.active && sameEndpoint(l.primary, primary)) l.active = false;
    const id = "L" + ++this.s.linkSeq;
    const link = { id, mode, name: name ?? null, active: true, createdAt: Date.now(), primary, advisor: advisor ?? null, reviews: 0, advisories: [] };
    if (!advisor) link.joinCode = crypto.randomBytes(3).toString("hex");
    this.s.links[id] = link;
    logEvent({ op: "link_create", id, primary, advisor: advisor ?? null });
    return { id, joinCode: link.joinCode ?? null };
  }

  op_link_join({ code, endpoint }) {
    const link = Object.values(this.s.links).find((l) => l.active && l.joinCode && l.joinCode === code);
    if (!link) throw new Error("no open link with that join code");
    if (sameEndpoint(link.primary, endpoint)) throw new Error("a chat can't advise itself");
    link.advisor = endpoint;
    delete link.joinCode;
    logEvent({ op: "link_join", id: link.id, advisor: endpoint });
    return { id: link.id, primary: link.primary };
  }

  op_link_close({ endpoint, linkId }) {
    const closed = [];
    for (const l of Object.values(this.s.links)) {
      if (!l.active) continue;
      if (linkId ? l.id === linkId : sameEndpoint(l.primary, endpoint) || sameEndpoint(l.advisor, endpoint)) {
        l.active = false;
        closed.push(l.id);
      }
    }
    logEvent({ op: "link_close", closed });
    return { closed };
  }

  // From the primary's Stop hook. A turn the advisor itself triggered is not
  // sent back for review (no advisor → primary → advisor cascade).
  op_turn_end({ endpoint, turnId, lastMessage }) {
    const link = this.linkFor("primary", endpoint);
    if (!link?.advisor) return { skipped: link ? "advisor not joined" : "no link" };
    if (link.awaitingAdvisoryTurn) {
      link.awaitingAdvisoryTurn = false;
      logEvent({ op: "turn_end", link: link.id, turnId, skipped: "advisory follow-up" });
      return { skipped: "advisory follow-up" };
    }
    link.reviews++;
    const text =
      `Primary (${endpoint.app}) finished a turn${turnId ? ` (${turnId})` : ""}. Its final message:\n\n` +
      (lastMessage?.trim() || "(no text)").slice(0, MAX_TEXT - 500);
    return this.post({ from: endpoint.app, toEndpoint: link.advisor, kind: "review-request", linkId: link.id, text });
  }

  // From the advisor (bridge_advise). blocker/concern wake the primary once;
  // nits wait for its next prompt; repeated notes are dropped.
  op_advise({ endpoint, verdict, severity, note, findings }) {
    const link = this.linkFor("advisor", endpoint);
    if (!link) throw new Error("this chat is not the advisor of an active link");
    if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join("|")}`);
    const body = [note?.trim(), ...(findings ?? []).map((f) => `- ${typeof f === "string" ? f : JSON.stringify(f)}`)].filter(Boolean).join("\n");
    // empty "nothing to say" answers aren't repeats of each other
    const dup = !!body && link.advisories.some((a) => a.body === body && a.severity === severity);
    link.advisories.push({ at: Date.now(), verdict, severity, body, dup });
    if (dup || severity === "none" || !body) return { delivered: "none", dup };
    if (severity === "nit") {
      this.s.notes.push({ id: "n" + ++this.s.seq, linkId: link.id, to: link.primary, text: body, at: Date.now(), deliveredAt: null });
      return { delivered: "next prompt" };
    }
    link.awaitingAdvisoryTurn = true;
    const text = `Verdict: ${verdict ?? "-"} · severity: ${severity}\n\n${body}`;
    return { delivered: "now", ...this.post({ from: endpoint.app, toEndpoint: link.primary, kind: "advisory", linkId: link.id, text }) };
  }

  op_notes_ack({ ids }) {
    for (const n of this.s.notes) if (ids?.includes(n.id)) n.deliveredAt = Date.now();
    return { ok: true };
  }

  op_wake_ack({ ids }) {
    for (const m of this.s.messages) if (ids?.includes(m.id)) m.wakes = (m.wakes ?? 0) + 1;
    return { ok: true };
  }

  post({ from, toEndpoint, kind, linkId, text }) {
    const s = this.s;
    if (s.messages.length >= MAX_MESSAGES_PER_RUN)
      throw new Error(`run ${s.runId} reached ${MAX_MESSAGES_PER_RUN} messages; reset the bridge to continue`);
    const msg = { id: "m" + ++s.seq, from, to: toEndpoint.app, toEndpoint, kind, linkId, text, ts: Date.now(), readAt: null, claim: null, wake: null };
    s.messages.push(msg);
    logEvent({ op: "send", runId: s.runId, id: msg.id, from, to: toEndpoint, kind, linkId, len: text.length });
    return { id: msg.id };
  }

  op_ping() {
    return { pid: process.pid, protocol: PROTOCOL };
  }

  op_reset() {
    this.s = freshState();
    logEvent({ op: "reset", runId: this.s.runId });
    return { runId: this.s.runId };
  }

  // `from` is fixed by the calling server process's --side, never by the model.
  op_send({ from, to, text }) {
    const s = this.s;
    if (!to) to = SIDES.find((x) => x !== from);
    if (!SIDES.includes(to)) throw new Error(`bad recipient: ${to}`);
    if (typeof text !== "string" || !text.trim()) throw new Error("empty message");
    if (text.length > MAX_TEXT) throw new Error(`message too long (${text.length} > ${MAX_TEXT})`);
    if (s.messages.length >= MAX_MESSAGES_PER_RUN)
      throw new Error(`run ${s.runId} reached ${MAX_MESSAGES_PER_RUN} messages; reset the bridge to continue`);
    const msg = { id: "m" + ++s.seq, from, to, text, ts: Date.now(), readAt: null, claim: null, wake: null };
    s.messages.push(msg);
    logEvent({ op: "send", runId: s.runId, id: msg.id, from, to, len: text.length });
    return { id: msg.id, step: s.messages.length, maxMessages: MAX_MESSAGES_PER_RUN };
  }

  // Messages for a specific chat only reach that chat; untargeted ones any
  // chat of the side (the original peer mode)
  op_receive({ side, endpoint }) {
    const now = Date.now();
    const out = this.s.messages.filter((m) => m.to === side && !m.readAt && (!m.toEndpoint || sameEndpoint(m.toEndpoint, endpoint)));
    for (const m of out) m.readAt = now;
    logEvent({ op: "receive", side, endpoint, ids: out.map((m) => m.id) });
    return { runId: this.s.runId, messages: out.map(({ id, from, kind, linkId, text, ts }) => ({ id, from, kind, linkId, text, ts })) };
  }

  // Widget heartbeat + list of messages that still need a wake-up.
  op_poll({ side, widgetId, visibility, focused, gapMs, host }) {
    const now = Date.now();
    const w = (this.s.widgets[widgetId] ??= { side, host, firstSeen: now, polls: 0 });
    w.polls++;
    w.lastPoll = now;
    w.visibility = visibility;
    w.focused = focused;
    logEvent({ op: "poll", side, widgetId, visibility, focused, gapMs });
    // chat-targeted messages have their own wake paths (queue / listener hook)
    const pending = this.s.messages.filter(
      (m) => m.to === side && !m.toEndpoint && !m.readAt && !m.wake?.ok && !(m.claim && now - m.claim.at < CLAIM_TTL_MS),
    );
    return { side, pending: pending.map((m) => ({ id: m.id, from: m.from })) };
  }

  // Lease so that only one widget per side fires ui/message for a given message.
  op_claim({ side, widgetId, id }) {
    const m = this.s.messages.find((x) => x.id === id && x.to === side);
    const now = Date.now();
    if (!m || m.readAt || m.wake?.ok) return { ok: false, reason: "not pending" };
    if (m.claim && m.claim.widgetId !== widgetId && now - m.claim.at < CLAIM_TTL_MS)
      return { ok: false, reason: "claimed by " + m.claim.widgetId };
    m.claim = { widgetId, at: now };
    logEvent({ op: "claim", side, widgetId, id });
    return { ok: true, from: m.from };
  }

  // Free-form telemetry from widgets (init, ui/message results, visibility, teardown).
  op_report({ side, widgetId, event, data }) {
    if (event === "wake-result" && data?.id) {
      const m = this.s.messages.find((x) => x.id === data.id);
      if (m) m.wake = { widgetId, ok: !!data.ok, at: Date.now(), detail: data };
    }
    if (event === "init") (this.s.widgets[widgetId] ??= { side, firstSeen: Date.now(), polls: 0 }).init = data;
    logEvent({ op: "report", side, widgetId, event, data });
    return { ok: true };
  }
}

// ------------------------------------------------------------- client side

let owner = null; // BrokerState when this process owns the port
const TOKEN = token();

function listen() {
  return new Promise((resolve) => {
    const state = new BrokerState();
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/rpc" || req.headers["x-bridge-token"] !== TOKEN) {
        res.writeHead(403).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let out;
        let stepDown = false;
        try {
          const { op, args, protocol } = JSON.parse(body);
          if ((protocol ?? 0) > PROTOCOL) {
            stepDown = true;
            out = { ok: false, stale: true, error: `broker owner runs protocol ${PROTOCOL}, client ${protocol}; stepping down` };
          } else out = { ok: true, result: state.handle(op, args || {}) };
        } catch (e) {
          out = { ok: false, error: String(e.message || e) };
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        if (stepDown) {
          logEvent({ op: "broker-step-down", pid: process.pid, protocol: PROTOCOL });
          clearInterval(state.ingestTimer);
          srv.close();
          srv.closeAllConnections?.();
          if (owner === state) owner = null;
        }
      });
    });
    srv.once("error", () => resolve(null));
    srv.listen(PORT, "127.0.0.1", () => {
      srv.unref();
      logEvent({ op: "broker-start", pid: process.pid });
      state.ingestOutbox();
      state.dispatch(); // messages left undelivered by a previous owner
      state.ingestTimer = setInterval(() => state.ingestOutbox(), 500);
      state.ingestTimer.unref();
      resolve(state);
    });
  });
}

function post(op, args) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/rpc", method: "POST", headers: { "x-bridge-token": TOKEN, "content-type": "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let r;
          try {
            r = JSON.parse(body);
          } catch {
            return reject(new Error(`broker HTTP ${res.statusCode}`));
          }
          if (r.ok) return resolve(r.result);
          const e = new Error(r.error);
          if (r.stale) e.code = "STALE_OWNER";
          reject(e);
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ op, args, protocol: PROTOCOL }));
  });
}

let triedListen = false;

// Long-lived processes (the MCP servers) keep a broker owner alive: if the
// owner dies, the next ping takes over within intervalMs, so hook requests in
// outbox/ never wait for some unrelated call to come along.
export function keepOwner(intervalMs = 2000) {
  const t = setInterval(() => call("ping").catch(() => {}), intervalMs);
  t.unref();
  return t;
}

export async function call(op, args = {}) {
  if (!owner && !triedListen) {
    triedListen = true;
    owner = await listen();
  }
  if (owner) return owner.handle(op, args);
  try {
    return await post(op, args);
  } catch (e) {
    if (e.code !== "ECONNREFUSED" && e.code !== "ECONNRESET" && e.code !== "STALE_OWNER") throw e;
    // previous owner is gone or just stepped down; take over
    for (let i = 0; i < 10 && !owner; i++) {
      owner = await listen();
      if (!owner) await new Promise((r) => setTimeout(r, 100));
    }
    if (owner) return owner.handle(op, args);
    return post(op, args);
  }
}
