# peer-bridge

Let **Claude Code** (the Code tab of Claude Desktop) and **ChatGPT Desktop** check each other's work from their own desktop apps. Both sides are ordinary chats in the official apps; no model APIs are used. Either app can take either role.

- **Advisor:** a chat in one app reviews every turn of a primary chat in the other.
- **One-off review:** ask a chat in the other app once, optionally in a brand-new ChatGPT thread with a model you pick.

> **Status: alpha.** It works end to end on Windows, in both directions, in the author's setup. macOS support is designed in but has not been verified on a Mac yet.
>
> The ChatGPT side relies on undocumented parts of the app: its bundled `codex app-server` experimental API and the `codex://threads/wake` deep link. Any app update can break these.
>
> Code you work on is sent to the other vendor's chat.

## How it works

```
primary chat ──Stop hook──▶ outbox ──▶ broker ──▶ advisor chat
     ▲          (question, answer, diff)              │
     └──── concern / blocker: wakes the primary ◀─────┘ bridge_advise
           nit: added to the user's next prompt
```

**Trigger.** A non-blocking `Stop` hook in both apps queues each finished turn of a linked primary for review. It never holds the turn open and never waits. The review request contains:

- the user's message for that turn,
- the primary's final answer,
- the git diff of what changed in the working tree during the turn.

**Diff baseline.** The `UserPromptSubmit` hook takes a snapshot when the turn starts, using `git stash create`, which doesn't touch any files or refs. Files that tend to hold secrets (`.env*`, keys, certificates, `*secret*`, `*credential*`) are never included, not even by name.

**Waking the other chat:**

- **ChatGPT:** the prompt goes into the thread's own queue, through the app's bundled `codex app-server`. `codex://threads/wake/<id>` then makes the desktop app run it.
- **Claude Code:** a background hook with `asyncRewake` exits 2 when something arrives for that session. It is re-armed on every `Stop` and `SessionStart`, so it survives restarts without the model doing anything.

**Identity.** The bridge learns which chat is calling from the host itself: `CLAUDE_CODE_SESSION_ID` on the Claude side and `_meta.threadId` on the ChatGPT side. It never relies on the model remembering, so context compaction can't break a link.

**Advice.** The advisor answers with `bridge_advise(verdict, severity, note, findings)`:

| Severity | What happens |
|---|---|
| `concern`, `blocker` | The primary is woken for one follow-up turn. That turn is not sent back for review, so reviews can't loop. |
| `nit` | Waits and is added to the user's next prompt. |

Repeated notes are dropped. A one-off review always sends its answer back, then closes.

**Problems are visible.** These problems show up in the affected chat's next prompt, and in `bridge_status`:

- a ChatGPT delivery fails (for example, the app isn't available),
- a Claude advisor session isn't open and listening.

**Broker.** A small local store shared by both apps' MCP servers: localhost HTTP plus a state file. Hooks never use the network; they read the state file and drop requests into an outbox folder. If the owning process dies, another server takes over within about 2 s. Old messages are pruned: read ones after a day, everything after a week.

## Tools

| Tool | Purpose |
|---|---|
| `bridge_link` | Make this chat a primary whose every turn is reviewed. From Claude, `advisor="openai"` creates a new ChatGPT advisor thread (you pick the model; it runs read-only). `advisor="join"` returns a code that any existing chat can use. |
| `bridge_review` | Ask for a one-off review of a `request`, with uncommitted changes attached. From Claude, `reviewer="openai"` opens a new ChatGPT thread (for example `model="gpt-6-luna"`). `reviewer="join"` returns a code. The answer arrives as a new turn. |
| `bridge_link_join` | Become the advisor or reviewer of a link, using its code. |
| `bridge_advise` | The advisor's or reviewer's structured answer. |
| `bridge_unlink` | Close this chat's links. |
| `bridge_status` | Show this chat's links, their health, whether Claude sides are listening, and pending notes. |
| `bridge_receive` / `bridge_send` | Read incoming messages. Send free-form messages to the other app. |

## Install

Requires Node.js 22+, git, and both desktop apps.

```bash
npm install
node scripts/install.mjs            # node scripts/install.mjs --uninstall to remove
```

The installer:

- registers the MCP server in Claude Code (user scope) and in ChatGPT Desktop (`~/.codex/config.toml`);
- adds the hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`;
- allows the bridge's own tools without approval prompts on both sides, because a woken chat can't wait for a click;
- backs up every file it changes and leaves other settings and hooks alone.

On Windows, Codex hooks get a PowerShell-safe command.

Restart both apps afterwards. Hooks point at this checkout, so re-run the installer if you move it.

## Known limits

- A Claude Code session can only be woken while it is open in Claude Desktop. Reviews for a closed advisor session wait until it opens, and the primary is told.
- The Claude listener stops after 12 hours without activity. It re-arms with the next turn of that session.
- Advisor and reviewer threads that the bridge creates in ChatGPT run read-only. A chat that joins with a code keeps its own permissions; it is only told not to act on the project.
- macOS paths (the bundled `codex` and `claude` CLIs, `open -g` for deep links) haven't been verified on a Mac.

## Tests

```bash
npm test
```

- `scripts/smoke.mjs`: end to end over MCP with two real server processes, the hooks, and a throwaway git repo.
- `scripts/test-link.mjs`: links, reviews, hooks, error notes, pruning and broker ownership handover.
- `scripts/test-install.mjs`: install, reinstall and uninstall against throwaway config directories.

## Repository layout

- `src/`
  - `server.mjs`: MCP server.
  - `broker.mjs`: shared state.
  - `hook.mjs`: hooks for both apps.
  - `git.mjs`: turn diffs.
  - `codex.mjs`: ChatGPT thread driver.
  - `caller.mjs`: caller identity.
  - `platform.mjs`: OS paths.
- `scripts/`
  - `install.mjs`
  - the tests
  - `send.mjs`, `codex-thread.mjs`: debugging helpers.
- `TEST.md`: lab notebook (in Turkish) with the experiments and measurements behind this design.
- `docs/`: research notes.
