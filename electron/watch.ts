import fs from "node:fs";
import path from "node:path";

import { locate } from "./transcripts.ts";
import { locateCodex } from "./providers/codex.ts";
import { locateCopilot } from "./providers/copilot.ts";
import { claudeProjects, codexArchived, codexSessions, copilotState } from "./paths.ts";
import type { SessionId } from "../shared/types.ts";

/** Files any provider reads: .jsonl, Codex's compressed pages, Copilot's yaml. */
const TRANSCRIPT = /\.(jsonl|jsonl\.zst|yaml)$/;

/**
 * Debounce window for disk events.
 *
 * The CLI appends a transcript one record per content block, so a single reply
 * arrives as a burst of writes. Re-parsing on each one would reparse the file
 * dozens of times per turn; a short quiet period coalesces the burst into one
 * refresh while still feeling immediate.
 */
const QUIET_MS = 250;

/**
 * Codex needs POLLING, not just fs.watch: its rollout appends are invisible to
 * macOS FSEvents. Verified empirically (v0.145.0) — with a recursive AND a flat
 * watch on the rollout's own directory, a live codex turn grew the file by
 * kilobytes (stat saw it within 200 ms) and neither watcher fired once in 60 s;
 * an append to the SAME file from another process fired immediately. Codex's
 * events surface only when it closes the file (exec mode delivers everything in
 * one burst at process exit). So fs.watch stays — it covers Claude, Copilot,
 * and codex fork/file creation on close — and a cheap stat sweep of the
 * codex/copilot roots catches the writes FSEvents never reports.
 */
const POLL_MS = 1000;

export interface Watcher {
  close(): void;
}

/**
 * Fingerprint every transcript under `dir`: path + size + mtime. A change in
 * any of them changes the string. Bounded depth (codex is Y/M/D + file = 3,
 * copilot is <id>/events.jsonl = 2); only transcript extensions are statted,
 * so a sweep is a few hundred stats — well under a millisecond of syscalls.
 */
function treeSignature(dir: string, depth = 0): string {
  let out = "";
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 3) out += treeSignature(p, depth + 1);
    } else if (TRANSCRIPT.test(e.name)) {
      try {
        const s = fs.statSync(p);
        out += `${p}:${s.size}:${s.mtimeMs}\n`;
      } catch {
        // deleted mid-sweep; the disappearance shows up as a shorter signature
      }
    }
  }
  return out;
}

/**
 * Watch a session's family, or — with `sessionId: null` — every root, and
 * call `onChange` once per burst of writes.
 *
 * Watching a session means watching its *directory* rather than the file:
 * editors and the CLI both replace files, a watch on an inode goes deaf the
 * moment the file is rewritten — and a tree is a FAMILY of sessions that can
 * grow through any member, or through a brand-new fork file next to them.
 */
export function watchTranscripts(
  sessionId: SessionId | null,
  onChange: () => void,
): Watcher {
  // Codex/Copilot roots are ALSO stat-polled — see POLL_MS for why fs.watch
  // alone goes deaf there. The parse caches keep the rescans cheap.
  const targets: { dir: string; poll: boolean }[] = [];
  const codexRoots = () => {
    targets.push({ dir: codexSessions(), poll: true });
    targets.push({ dir: codexArchived(), poll: true });
  };

  if (sessionId) {
    const loc = locate(sessionId);
    if (loc) targets.push({ dir: path.dirname(loc.file), poll: false });
    else if (locateCodex(sessionId)) codexRoots();
    else if (locateCopilot(sessionId)) targets.push({ dir: copilotState(), poll: true });
    else return { close() {} };
  } else {
    targets.push({ dir: claudeProjects(), poll: false });
    codexRoots();
    targets.push({ dir: copilotState(), poll: true });
  }

  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, QUIET_MS);
  };

  const polls: NodeJS.Timeout[] = [];
  for (const { dir, poll } of targets) {
    if (!poll || !fs.existsSync(dir)) continue;
    let sig = treeSignature(dir);
    polls.push(
      setInterval(() => {
        const next = treeSignature(dir);
        if (next !== sig) {
          sig = next;
          fire();
        }
      }, POLL_MS),
    );
  }

  const watchers: fs.FSWatcher[] = [];
  for (const { dir } of targets) {
    try {
      const w = fs.watch(dir, { recursive: true }, (_event, filename) => {
        // Claude/Codex append .jsonl; Codex rotates pages to .jsonl.zst;
        // Copilot appends events.jsonl inside a session dir, and yaml changes
        // ride along on the same debounce as their neighbouring events write.
        if (filename && !TRANSCRIPT.test(filename)) return;
        fire();
      });
      // A watcher on a directory the user may delete shouldn't take the app down.
      w.on("error", () => w.close());
      watchers.push(w);
    } catch {
      // Missing directory (harness not installed) — the others still watch.
    }
  }
  if (watchers.length === 0 && polls.length === 0) return { close() {} };

  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const p of polls) clearInterval(p);
    },
  };
}
