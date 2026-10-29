# peer-bridge

Let **Claude Code** (the Code tab of Claude Desktop) and **ChatGPT Desktop** work on the same task from their own desktop apps: one chat is the **primary**, a chat in the other app is its **advisor** and checks every turn. Either app can take either role. No model APIs: both sides are ordinary chats in the official desktop apps.

> **Status: experimental.** Works on Windows in the author's setup. macOS support is designed in but not yet verified on a Mac. The ChatGPT side relies on undocumented parts of the app (its bundled `codex app-server` experimental API and the `codex://threads/wake` deep link), which can break with any app update.

## How it works

```
primary chat ──Stop hook──▶ outbox ──▶ broker ──▶ advisor chat
     ▲                                               │
     └──── concern / blocker: wakes the primary ◀────┘ bridge_advise
           nit: added to the user's next prompt
```

- **Trigger:** a non-blocking `Stop` hook in both apps queues each finished turn of a linked primary for review. It never holds the turn open and never waits.
- **Waking the advisor/primary:**
  - ChatGPT: the prompt goes into the thread's own queue (through the app's bundled `codex app-server`), and `codex://threads/wake/<id>` makes the desktop app run it.
  - Claude Code: a background hook with `asyncRewake` exits 2 when something arrives for that session. It is re-armed on every `Stop` and `SessionStart`, so it survives restarts without the model doing anything.
- **Identity:** the bridge knows which chat called it from the host itself (`CLAUDE_CODE_SESSION_ID` on the Claude side, `_meta.threadId` on the ChatGPT side). It never relies on the model remembering, so context compaction can't break a link.
- **Advice:** the advisor answers with `bridge_advise(verdict, severity, note, findings)`. `concern` and `blocker` wake the primary for one follow-up turn. That follow-up is not sent back for review, so there are no loops. `nit` waits for the next prompt (`UserPromptSubmit` hook). Repeated notes are dropped.
- **Broker:** a small local state store shared by both apps' MCP servers (localhost HTTP plus a state file). Hooks don't use the network; they read the state file and drop requests into an outbox folder.

## Tools

| Tool | Purpose |
|---|---|
| `bridge_link` | Make this chat a primary. From Claude: `advisor="openai"` creates a new ChatGPT advisor thread (pick a model, read-only sandbox). `advisor="join"` returns a code for any existing chat. |
| `bridge_link_join` | Make this chat the advisor of a link, using the code. |
| `bridge_advise` | Advisor's structured answer to a review request. |
| `bridge_unlink` | Close this chat's links. |
| `bridge_receive` / `bridge_send` / `bridge_status` | Read and send messages, and inspect state. |

## Install

Requires Node.js 22+ and both desktop apps.

```bash
npm install
node scripts/install.mjs            # node scripts/install.mjs --uninstall to remove
```

The installer:

- Registers the MCP server in Claude Code (user scope) and in ChatGPT Desktop (`~/.codex/config.toml`).
- Adds the hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`.
- Allows the bridge's own tools without approval prompts on both sides. A woken chat can't wait for a click.
- Backs up every file it changes, and leaves other settings and hooks alone.

Restart both apps afterwards.

## Tests

```bash
npm test
```

The tests cover the broker, both directions of a link, the hooks (run as real subprocesses with hook JSON on stdin), broker ownership handover, and install/uninstall against throwaway config directories.

## Repository layout

- `src/`: MCP server, broker, hooks, platform paths, ChatGPT thread driver.
- `scripts/`: installer, tests, and tools from the wake-up experiments.
- `TEST.md`: lab notebook (in Turkish) with every experiment and measurement that led to this design.
- `docs/`: research notes.
