// Turn diffs (src/git.mjs) against throwaway repos: secrets stay out (files
// and whole directories, content and names), repos without commits work,
// edits to already-untracked files show up, and the size cap covers it all.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { baseline, turnDiff } from "../src/git.mjs";

function repo({ commit = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-git-"));
  const git = (...a) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  git("init", "-q");
  if (commit) {
    fs.writeFileSync(path.join(d, "a.js"), "1\n");
    git("add", ".");
    git("commit", "-qm", "init");
  }
  return { d, git, write: (f, c) => (fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }), fs.writeFileSync(path.join(d, f), c)) };
}

// secrets: files and directories, never content nor name
{
  const r = repo();
  const base = baseline(r.d);
  for (const f of ["secrets/config.json", ".envrc", ".env.local", "my-credentials/x.txt", "deploy/server.pem", ".ssh/id_ed25519", "config/app_secret.yml"]) r.write(f, "TOPSECRET\n");
  r.write("a.js", "2\n");
  const d = turnDiff(r.d, base, 20000);
  assert.match(d, /a\.js/);
  assert.doesNotMatch(d, /TOPSECRET|secrets|envrc|\.env|credentials|\.pem|\.ssh|app_secret/);
  console.log("git 1 secret files and directories excluded (content and names)");
}

// repo without commits: baseline and diff still work
{
  const r = repo({ commit: false });
  r.write("x.js", "old\n");
  const base = baseline(r.d);
  assert.ok(base, "baseline in a repo without commits");
  r.write("x.js", "changed\n");
  r.write("y.js", "new\n");
  const d = turnDiff(r.d, base, 20000);
  assert.match(d, /New untracked files:\ny\.js/);
  assert.match(d, /Edited untracked files[^\n]*:\nx\.js/);
  assert.ok(turnDiff(r.d, null, 20000), "no-baseline diff works without HEAD too");
  console.log("git 2 repo without commits: new and edited untracked files reported");
}

// edits to a file that was already untracked at turn start
{
  const r = repo();
  r.write("notes.md", "v1\n");
  const base = baseline(r.d);
  assert.equal(turnDiff(r.d, base, 20000), "(no changes)");
  r.write("notes.md", "v2\n");
  assert.match(turnDiff(r.d, base, 20000), /Edited untracked files[^\n]*:\nnotes\.md/);
  console.log("git 3 edited pre-existing untracked file reported");
}

// the cap covers summary and file lists, not just the patch
{
  const r = repo();
  for (let i = 0; i < 300; i++) r.write(`f${i}.txt`, "a\n");
  r.git("add", ".");
  r.git("commit", "-qm", "many");
  const base = baseline(r.d);
  for (let i = 0; i < 300; i++) r.write(`f${i}.txt`, "b".repeat(500) + "\n");
  for (let i = 0; i < 120; i++) r.write(`new${i}.txt`, "n\n");
  const d = turnDiff(r.d, base, 3000);
  assert.ok(d.length <= 3000, `capped at 3000 (got ${d.length})`);
  assert.match(d, /more files/);
  assert.match(d, /… 70 more/);
  console.log(`git 4 size cap holds for stat, lists and patch (${d.length} chars)`);
}
