// What changed in the working tree during a turn, for review requests.
// Read-only: `git stash create` writes a commit object for the current tree
// but touches no ref, index or file. Files that tend to hold secrets never
// leave the machine (the diff goes to the other vendor's chat).

import { execFileSync } from "node:child_process";

const SECRET_PATHS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "*secret*", "*credential*", "*.keystore"];
const EXCLUDES = SECRET_PATHS.map((p) => `:(glob,exclude)**/${p}`);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

const untracked = (cwd) => git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDES]).split("\n").filter(Boolean);

// Snapshot at turn start, or null when cwd isn't a git work tree
export function baseline(cwd) {
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return null;
    let ref = git(cwd, ["stash", "create"]).trim();
    if (!ref) {
      try {
        ref = git(cwd, ["rev-parse", "HEAD"]).trim();
      } catch {
        ref = EMPTY_TREE; // repo without commits
      }
    }
    return { cwd, ref, untracked: untracked(cwd) };
  } catch {
    return null;
  }
}

// Diff of the working tree against a baseline (or HEAD without one), capped
export function turnDiff(cwd, base, maxChars) {
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return null;
    const ref = base?.ref ?? "HEAD";
    const stat = git(cwd, ["diff", "--stat", ref, "--", ".", ...EXCLUDES]).trim();
    const before = new Set(base?.untracked ?? []);
    const added = untracked(cwd).filter((f) => !before.has(f));
    if (!stat && !added.length) return base ? "(no changes)" : null;
    let patch = git(cwd, ["diff", ref, "--", ".", ...EXCLUDES]);
    const head = [
      base ? null : "(no turn baseline: uncommitted changes against HEAD)",
      stat,
      added.length && `New untracked files:\n${added.slice(0, 50).join("\n")}${added.length > 50 ? `\n… ${added.length - 50} more` : ""}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const room = maxChars - head.length - 100;
    if (patch.length > room) patch = patch.slice(0, Math.max(0, room)) + "\n… (diff truncated)";
    return `${head}\n\n${patch}`.trim();
  } catch {
    return null;
  }
}
