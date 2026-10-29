// Experimental: hand a prompt to ChatGPT Desktop through the app's own queue
// (see src/codex.mjs).
//   node scripts/codex-thread.mjs --new --model gpt-6-luna [--name N] [--seed S] "prompt"
//   node scripts/codex-thread.mjs --thread <id> "prompt"     (add --no-wake to skip the deep link)
//   node scripts/codex-thread.mjs --thread <id> --list | --clear

import { createThread, sendToThread, listQueue, clearQueue } from "../src/codex.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args.splice(i, 1).length > 0;
};
const isNew = flag("--new");
const model = opt("--model");
const name = opt("--name");
const seed = opt("--seed");
const cwd = opt("--cwd");
let threadId = opt("--thread");
const noWake = flag("--no-wake");
const list = flag("--list");
const clear = flag("--clear");
const prompt = args.join(" ");
const opts = { debug: !!process.env.DEBUG };

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

if (isNew) {
  const r = await createThread({ model, cwd, name, seed }, opts);
  threadId = r.threadId;
  log("created", threadId, "model", r.model);
}
if (!threadId) throw new Error("--new or --thread <id> required");
if (clear) log("cleared", await clearQueue(threadId, opts), "item(s)");
if (prompt) {
  const r = await sendToThread(threadId, prompt, { wake: !noWake, ...opts });
  log("queued", r.queued, noWake ? "(no wake)" : "and woke the app");
}
if (list) log("queue", JSON.stringify(await listQueue(threadId, opts)));
console.log(JSON.stringify({ threadId }));
