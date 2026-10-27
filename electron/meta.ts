import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentreeHome } from "./paths.ts";
import type { NodeId, NodeMeta, SessionId, TurnNode } from "../shared/types.ts";

/**
 * Agentree's sidecar metadata: labels, dead-end marks, notes.
 *
 * Kept strictly separate from Claude Code's transcripts. Those files are the
 * user's real work and are owned by the CLI — writing our annotations into
 * them would risk corrupting a session the CLI is mid-append on, and would
 * make our UI state indistinguishable from real conversation content.
 */
const DIR = () => path.join(agentreeHome(), "meta");

// The app used to be called AgentView and kept its sidecar in ~/.agentview.
// Carry existing annotations across once; a failed rename (permissions, race)
// just leaves the old dir in place for a later attempt.
const OLD_ROOT = path.join(os.homedir(), ".agentview");
try {
  if (!process.env.AGENTREE_HOME && fs.existsSync(OLD_ROOT) && !fs.existsSync(agentreeHome())) {
    fs.renameSync(OLD_ROOT, agentreeHome());
  }
} catch {
  /* keep reading/writing the new location; old annotations stay recoverable */
}

function fileFor(sessionId: SessionId): string | null {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return null;
  return path.join(DIR(), `${sessionId}.json`);
}

export function readMeta(sessionId: SessionId): Record<NodeId, NodeMeta> {
  const file = fileFor(sessionId);
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<NodeId, NodeMeta>;
  } catch {
    return {};
  }
}

/** Merge a patch into an entry; a cleared field (undefined, null, "") is removed. */
function merged(prev: NodeMeta | undefined, patch: NodeMeta): NodeMeta | undefined {
  const next: NodeMeta = { ...prev, ...patch };
  for (const k of Object.keys(next) as (keyof NodeMeta)[]) {
    if (next[k] === undefined || next[k] === null || next[k] === "") delete next[k];
  }
  return Object.keys(next).length ? next : undefined;
}

/**
 * Apply several entry patches to ONE sidecar in one atomic replacement —
 * never a rewrite per entry. Atomic per file only: two Agentree processes
 * (the desktop app and the extension) writing the same sidecar at the same
 * moment can still lose one side's change. Last writer wins.
 */
function updateFile(sessionId: SessionId, patches: Map<string, NodeMeta>): void {
  const file = fileFor(sessionId);
  if (!file || patches.size === 0) return;
  const all = readMeta(sessionId);
  for (const [key, patch] of patches) {
    const next = merged(all[key], patch);
    if (next) all[key] = next;
    else delete all[key];
  }
  fs.mkdirSync(DIR(), { recursive: true });
  // Write-then-rename so a crash can't leave a half-written JSON file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

export function writeMeta(sessionId: SessionId, key: string, patch: NodeMeta): void {
  updateFile(sessionId, new Map([[key, patch]]));
}

/**
 * The keys a node's annotation is stored under (v2): its semantic identities,
 * the same in every session holding a copy, so they outlive any one file.
 * Codex node ids already are such identities.
 */
const stableKeys = (n: TurnNode): string[] => (n.stableIds?.length ? n.stableIds : [n.id]);
/** The keys entries were stored under before (v1): raw per-file ids. */
const rawKeys = (n: TurnNode): NodeId[] => [
  n.id,
  ...(n.absorbedIds ?? []),
  ...(n.occurrences ?? []).map((o) => o.id),
];

/**
 * Overlay a family's annotations onto its nodes.
 *
 * A family's identity isn't stable: it gains members when a fork is found,
 * its root changes when the original is deleted, and one turn has a
 * different uuid in each file holding it. So every member's sidecar is read,
 * and a node matches on its semantic identity (`stableIds`).
 *
 * Sidecars written before that identity existed (v1) key entries by raw
 * uuid, usually in the family root's file only. Those are still found through
 * the node's own, merged-in and copied ids — and the first time one is, it is
 * carried forward under the node's stable ids into EVERY member's sidecar, so
 * it survives the root being deleted later. That carry-forward is the whole
 * migration: idempotent (a node with a v2 entry never looks for v1), with no
 * version flag, since the two key spaces can't collide. A v1 entry whose
 * source transcript was deleted BEFORE this ran can't be mapped to anything
 * on disk, and is not recovered.
 */
export function applyAnnotations(nodes: TurnNode[], memberIds: SessionId[]): void {
  const ids = [...new Set(memberIds)];
  const metas = ids.map(readMeta);
  const carry = new Map<string, NodeMeta>();
  for (const n of nodes) {
    let hit: NodeMeta | undefined;
    for (const meta of metas) {
      hit = stableKeys(n).map((k) => meta[k]).find(Boolean);
      if (hit) break;
    }
    if (!hit) {
      for (const meta of metas) {
        hit = rawKeys(n).map((k) => meta[k]).find(Boolean);
        if (hit) break;
      }
      if (hit) for (const k of stableKeys(n)) carry.set(k, hit);
    }
    if (hit) Object.assign(n, hit);
  }
  if (carry.size) {
    for (const sid of ids) {
      try {
        updateFile(sid, carry);
      } catch {
        /* read-only home: the v1 entries still resolve; retried next load */
      }
    }
  }
}

/**
 * Write an annotation so it survives what `applyAnnotations` has to cope
 * with: into EVERY member's sidecar, under the node's stable ids — one atomic
 * write per sidecar. Any v1 entry for the node in that sidecar gets the same
 * patch, so clearing a label can't let an older entry resurface.
 */
export function writeAnnotation(node: TurnNode, memberIds: SessionId[], patch: NodeMeta): void {
  for (const sid of new Set(memberIds)) {
    const existing = readMeta(sid);
    const patches = new Map<string, NodeMeta>(stableKeys(node).map((k) => [k, patch]));
    for (const k of rawKeys(node)) if (existing[k]) patches.set(k, patch);
    updateFile(sid, patches);
  }
}
