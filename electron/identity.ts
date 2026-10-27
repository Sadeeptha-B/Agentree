import crypto from "node:crypto";
import type { NodeId, TurnNode } from "../shared/types.ts";

/**
 * Semantic node identity (`TurnNode.stableIds`) — a PERSISTENCE contract:
 * annotations in `~/.agentree/meta/` are keyed by it, so a change here must
 * keep earlier keys findable (`legacyIds`, and `scheme2Fingerprint` below).
 *
 * Current scheme (3), per node:
 *
 *  - a STRONG own key — unique by itself: a Claude API message id
 *    (`m:<id>`), a prompt id with its text (`u:<promptId>|<digest>`), a
 *    Codex `<turnId>:<itemId>` — is the identity;
 *  - a WEAK own key — text alone (Copilot, legacy Codex, a Claude prompt
 *    with no prompt id) — is qualified by the parent's identity, as a
 *    fixed-size hash: `w:` + 24 hex of SHA-1 over JSON `[key, parentId]`
 *    (`"root"` for no parent). A copy repeats the whole prefix, so the chain
 *    and the hash are the same in every copy; the same text under another
 *    parent is another node; and an identity's size doesn't grow with the
 *    conversation's depth.
 *
 * Text is digested EXACTLY as the parser produced it: indentation and line
 * breaks are meaning in code, and a copy preserves them byte for byte.
 *
 * Earlier schemes, still read (meta.ts): (1) raw per-file uuids; (2) like
 * this one, but the digest folded whitespace runs (two prompts differing
 * only in indentation collided), and a weak key was qualified by the
 * parent's identity as a literal string, `key@parentIdentity` — quadratic in
 * a long text-keyed chain.
 */

const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

/** Digest of the WHOLE text, whitespace included — an identity, unlike a display gist. */
export const digest = (s: string) => sha1(s).slice(0, 20);
/** Scheme 2's digest: whitespace runs folded. Only to find keys saved under it. */
export const foldedDigest = (s: string) => sha1(s.replace(/\s+/g, " ").trim()).slice(0, 20);

/** Role + whole-text digest: the match key where text is the only evidence a copy keeps. */
export const textKey = (n: TurnNode) => `${n.role}:${digest(n.text)}`;
export const foldedTextKey = (n: TurnNode) => `${n.role}:${foldedDigest(n.text)}`;

const ROOT = "root";
/** A weak key under its parent's identity, at a fixed size. */
export const qualify = (key: string, parent: string) => `w:${sha1(JSON.stringify([key, parent])).slice(0, 24)}`;

export interface OwnKey {
  key: string;
  /** Unique on its own, so not qualified by the parent. */
  strong: boolean;
  /** The same key under scheme 2's digest, when it differs. */
  legacyKey?: string;
}

/**
 * Give every node its identity (`stableIds[0]`) and, where scheme 2 keyed it
 * differently, the bounded fingerprint of that older key (`legacyIds`,
 * see `scheme2Fingerprint`). `own` returns the node's key; parents come
 * from `parentId`.
 */
export function assignStableIds(nodes: TurnNode[], own: (n: TurnNode) => OwnKey): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Map<NodeId, { id: string; legacy: string }>();
  for (const start of nodes) {
    // Iterative: a text-keyed (Copilot, legacy Codex) chain is as deep as the
    // conversation is long.
    const path: TurnNode[] = [];
    const onPath = new Set<NodeId>();
    let base = { id: ROOT, legacy: ROOT };
    for (let cur: TurnNode | undefined = start; cur; ) {
      const hit = done.get(cur.id);
      if (hit) {
        base = hit;
        break;
      }
      if (onPath.has(cur.id)) break; // malformed (cyclic) transcript
      onPath.add(cur.id);
      path.push(cur);
      if (own(cur).strong) break;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const { key, strong, legacyKey = key } = own(path[i]);
      base = strong
        ? { id: key, legacy: legacyKey }
        : { id: qualify(key, base.id), legacy: qualify(legacyKey, base.legacy) };
      done.set(path[i].id, base);
    }
  }
  for (const n of nodes) {
    const { id, legacy } = done.get(n.id)!;
    n.stableIds = [id];
    n.legacyIds = legacy !== id ? [legacy] : undefined;
  }
}

/**
 * A scheme-2 key as the fingerprint `assignStableIds` computes for it
 * (`legacyIds`), so a saved key can be matched without rebuilding the
 * quadratic literal. A weak scheme-2 key reads `k_n@…@k_1@base`: the node's
 * own key, each weak ancestor's, then the nearest strong ancestor's key or
 * `root`. Folding it from the base re-applies the qualification. A key
 * without `@` was strong and is its own fingerprint.
 */
export function scheme2Fingerprint(saved: string): string {
  const parts = saved.split("@");
  let id = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) id = qualify(parts[i], id);
  return id;
}
