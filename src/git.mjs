// What changed in the working tree during a turn, for review requests.
// Read-only: `git stash create` writes a commit object for the current tree
// but touches no ref, index or file. Paths that tend to hold secrets never
// leave the machine, neither content nor name (the diff goes to the other
// vendor's chat).

import { execFileSync } from "node:child_process";

// file names, and directories whose whole content is excluded
const SECRET_FILES = [".env*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "id_rsa*", "id_ed25519*", "id_ecdsa*", "*secret*", "*credential*", ".netrc", ".npmrc", ".pypirc"];
const SECRET_DIRS = ["secrets", "*secret*", "*credential*", ".ssh", ".aws", ".gnupg", ".azure", ".kube"];
export const EXCLUDES = [...SECRET_FILES.map((p) => `:(glob,exclude)**/${p}`), ...SECRET_DIRS.map((d) => `:(glob,exclude)**/${d}/**`)];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_LIST = 50;

function git(cwd, args, input) {
  return execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    input,
    timeout: 3000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

function inWorkTree(cwd) {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function headOrEmpty(cwd) {
  try {
    return git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || EMPTY_TREE;
  } catch {
    return EMPTY_TREE; // repo without commits
  }
}

const untracked = (cwd) => git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDES]).split("\n").filter(Boolean);

// content hashes, so edits to files that were already untracked show up
function hashes(cwd, files) {
  if (!files.length) return {};
  const out = git(cwd, ["hash-object", "--stdin-paths"], files.join("\n") + "\n").trim().split("\n");
  return Object.fromEntries(files.map((f, i) => [f, out[i]]));
}

// Snapshot at turn start, or null when cwd isn't a git work tree
export function baseline(cwd) {
  if (!inWorkTree(cwd)) return null;
  try {
    let ref = "";
    try {
      ref = git(cwd, ["stash", "create"]).trim();
    } catch {
      // fails in a repo without commits
    }
    const files = untracked(cwd).slice(0, 500);
    return { cwd, ref: ref || headOrEmpty(cwd), untracked: hashes(cwd, files) };
  } catch {
    return null;
  }
}

const capList = (title, items) =>
  items.length ? `${title}:\n${items.slice(0, MAX_LIST).join("\n")}${items.length > MAX_LIST ? `\n… ${items.length - MAX_LIST} more` : ""}` : null;

// Diff of the working tree against a baseline (or HEAD without one); the
// whole result, summary included, stays within maxChars
export function turnDiff(cwd, base, maxChars) {
  if (!inWorkTree(cwd)) return null;
  try {
    const ref = base?.ref ?? headOrEmpty(cwd);
    const statLines = git(cwd, ["diff", "--stat", ref, "--", ".", ...EXCLUDES]).trimEnd().split("\n").filter(Boolean);
    const before = base?.untracked ?? {};
    const now = untracked(cwd);
    const added = now.filter((f) => !(f in before));
    const known = now.filter((f) => f in before);
    const nowHashes = hashes(cwd, known);
    const edited = known.filter((f) => nowHashes[f] !== before[f]);
    if (!statLines.length && !added.length && !edited.length) return base ? "(no changes)" : null;
    // a long stat is cut to its first lines plus the summary line
    const stat = statLines.length > MAX_LIST + 1 ? [...statLines.slice(0, MAX_LIST), `… ${statLines.length - MAX_LIST - 1} more files`, statLines.at(-1)] : statLines;
    const head = [
      base ? null : "(no turn baseline: uncommitted changes against HEAD)",
      stat.join("\n"),
      capList("New untracked files", added),
      capList("Edited untracked files (content not tracked by git)", edited),
    ]
      .filter(Boolean)
      .join("\n\n");
    let patch = git(cwd, ["diff", ref, "--", ".", ...EXCLUDES]);
    const room = maxChars - head.length - 40;
    if (patch.length > room) patch = room > 0 ? patch.slice(0, room) + "\n… (diff truncated)" : "";
    return `${head}\n\n${patch}`.trim().slice(0, maxChars);
  } catch {
    return null;
  }
}
