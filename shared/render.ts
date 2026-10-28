import type { ForkPoint, ForkSummary, MemberInfo, NodeId, NodeRef, SessionDetail, SessionId, SessionRef, TurnNode, UsageSnapshot } from "./types.ts";

export type NodeMap = Map<NodeId, TurnNode>;
export const ROOT_KEY = "\0root";

export function toNodeMap(nodes: TurnNode[]): NodeMap {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** parentId -> children, ordered oldest-first. */
export function childIndex(nodes: TurnNode[]): Map<string, TurnNode[]> {
  const idx = new Map<string, TurnNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? ROOT_KEY;
    const bucket = idx.get(key);
    if (bucket) bucket.push(n);
    else idx.set(key, [n]);
  }
  for (const bucket of idx.values()) bucket.sort((a, b) => a.timestamp - b.timestamp);
  return idx;
}

/** Walk from a leaf to the root and return the path root-first. */
export function pathToRoot(leaf: NodeId | null, nodes: NodeMap): TurnNode[] {
  const path: TurnNode[] = [];
  const seen = new Set<NodeId>();
  let id: NodeId | null = leaf;
  while (id) {
    if (seen.has(id)) break; // a malformed transcript must not hang the UI
    seen.add(id);
    const node = nodes.get(id);
    if (!node) break;
    path.push(node);
    id = node.parentId;
  }
  return path.reverse();
}

/** Follow the most recently created child until we hit a leaf. */
export function descendToNewestLeaf(id: NodeId, children: Map<string, TurnNode[]>): NodeId {
  let cur = id;
  const seen = new Set<NodeId>([cur]);
  for (;;) {
    const kids = children.get(cur);
    if (!kids || kids.length === 0) return cur;
    const next = kids[kids.length - 1].id;
    if (seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}

/**
 * The oldest of several start times (`SessionMeta.startedAt`): 0, unknown,
 * when any of them is, so the result stays a lower bound for every turn.
 */
export const oldest = (ts: number[]): number => (ts.length && ts.every((t) => t > 0) ? Math.min(...ts) : 0);

/** When a node's last part was written: a merged or streamed node ends after it starts. */
export const endOf = (n: Pick<TurnNode, "timestamp" | "endedAt">): number => Math.max(n.timestamp, n.endedAt ?? 0);

/**
 * Until when the work a node started was recorded: its end, or activity
 * under it after that (`activeUntil`). For idle time only — which branch is
 * latest is still `endOf`.
 */
export const activeEndOf = (n: Pick<TurnNode, "timestamp" | "endedAt" | "activeUntil">): number =>
  Math.max(endOf(n), n.activeUntil ?? 0);

/** The latest-ending of `list`; the first in list order on a tie. */
const latest = (list: TurnNode[]): NodeId => list.reduce((a, b) => (endOf(a) >= endOf(b) ? a : b)).id;

/**
 * The newest leaf anywhere in the session — where the CLI would resume.
 *
 * Prefers a leaf that actually has text: many leaves are tool-result-only user
 * turns, and opening a session onto an empty "(no text)" node is a poor first
 * impression of the conversation.
 */
export function newestLeaf(nodes: TurnNode[], children: Map<string, TurnNode[]>): NodeId | null {
  const leaves = nodes.filter((n) => (children.get(n.id)?.length ?? 0) === 0);
  if (leaves.length === 0) return null;
  const withText = leaves.filter((n) => n.text.trim().length > 0);
  return latest(withText.length > 0 ? withText : leaves);
}

/**
 * The latest-ending leaf among the nodes `holds` accepts — a leaf of that subset,
 * not of the whole tree (a turn whose only children belong to other
 * sessions is still where this one ends). Same text preference as
 * `newestLeaf`.
 */
export function heldTip(nodes: TurnNode[], holds: (n: TurnNode) => boolean): NodeId | null {
  const held = nodes.filter(holds);
  const ids = new Set(held.map((n) => n.id));
  const continued = new Set(held.filter((n) => n.parentId && ids.has(n.parentId)).map((n) => n.parentId!));
  const leaves = held.filter((n) => !continued.has(n.id));
  if (leaves.length === 0) return null;
  const withText = leaves.filter((n) => n.text.trim().length > 0);
  return latest(withText.length > 0 ? withText : leaves);
}

/**
 * The sessions holding a stitched node's copies: its owner and every session
 * recorded as an occurrence. Where copies are the only evidence (Claude,
 * Copilot, legacy Codex), this is `heldBy`.
 */
export function copyHolders(n: TurnNode): string[] {
  const out = n.sourceSessionId ? [n.sourceSessionId] : [];
  for (const o of n.occurrences ?? []) if (!out.includes(o.sessionId)) out.push(o.sessionId);
  return out;
}

/** Each member's `tipId`: the latest-ending leaf among the nodes that list it in `heldBy`. */
export function assignTips(nodes: TurnNode[], members: MemberInfo[]): void {
  for (const m of members) m.tipId = heldTip(nodes, (n) => !!n.heldBy?.includes(m.id)) ?? undefined;
}

/**
 * The member session the panel's open/resume act on for `node`: the focused
 * member when the turn is in its history (a quiet fork's shared prefix is
 * owned by its parent, but opening the fork must still open the fork), else
 * the session the turn belongs to, else the family's root.
 */
export function actionTarget(
  session: SessionDetail,
  node: TurnNode | null | undefined,
  focus: SessionId | null,
): { member: MemberInfo; ref: SessionRef } {
  const { meta, members } = session;
  const id = focus && node?.heldBy?.includes(focus) ? focus : (node?.sourceSessionId ?? meta.id);
  const member: MemberInfo = members.find((m) => m.id === id) ?? {
    id: meta.id,
    title: meta.title,
    parentId: null,
    cwd: meta.cwd,
    resumeCommand: meta.resumeCommand,
    activeAt: meta.activeAt,
    touchedAt: meta.touchedAt,
  };
  return { member, ref: { provider: meta.provider, sessionId: member.id, cwd: member.cwd } };
}

/** The cut a drawn node stands for: where its last part ends (`ForkPoint`). */
export const forkPointOf = (n: TurnNode): ForkPoint => ({
  nodeId: n.id,
  sessionId: n.sourceSessionId,
  endId: n.lastRawId ?? n.id,
});

/**
 * The node of a newer snapshot that ends where `p` did: the same node while
 * it still ends there, else the one node that now does (its group split
 * under the same head). Null when none does — the cut was folded into a
 * longer node, or its record is gone — or more than one does.
 */
export const resolveForkPoint = (nodes: TurnNode[], p: ForkPoint): TurnNode | null => endingAt(nodes, refOf, p);

/** What a drawn node stands for, to find it again in a newer snapshot (`locate`). */
export const refOf = (n: TurnNode): NodeRef => ({ point: forkPointOf(n), ...(n.stableIds ? { stableIds: n.stableIds } : {}) });

/**
 * The item that ends where `point` did: the same node while it still does,
 * else the one that now does. A session's record is in one family only, so
 * this holds across families too — the one rule a partial snapshot (a day's
 * turns) can apply. Null when none does, or more than one.
 */
export function endingAt<T>(items: Iterable<T>, refOfItem: (item: T) => NodeRef, point: ForkPoint): T | null {
  const all = [...items].map((item) => ({ item, p: refOfItem(item).point }));
  const ends = (p: ForkPoint) => p.sessionId === point.sessionId && p.endId === point.endId;
  const same = all.find(({ p }) => p.nodeId === point.nodeId);
  if (same && ends(same.p)) return same.item;
  const hits = all.filter(({ p }) => ends(p));
  return hits.length === 1 ? hits[0].item : null;
}

/**
 * Where a drawn node lives in a newer snapshot of ITS FAMILY. First the
 * node that ends where it did (`endingAt`): new membership can split a
 * display group under the same head id, and the head alone would quietly
 * shorten the selected prefix. Then the same id (a group that grew, or was
 * folded into a longer one), then the same semantic identity (a re-rooted
 * family draws it under other ids) — the one node holding one of its
 * identities, or else the one holding its last (where it ended). Null when
 * none does, or the identity is ambiguous.
 *
 * Ids and identities are unique only within a family: text-derived ones
 * repeat in unrelated chats that opened the same way. So `items` is one
 * family's nodes (`locate`), never a slice across families — a day's turns
 * are resolved in the worker (`registry.findWant`).
 */
export function locateBy<T>(items: Iterable<T>, refOfItem: (item: T) => NodeRef, ref: NodeRef): T | null {
  const list = [...items];
  const end = endingAt(list, refOfItem, ref.point);
  if (end) return end;
  const same = list.find((item) => refOfItem(item).point.nodeId === ref.point.nodeId);
  if (same) return same;
  const ids = ref.stableIds ?? [];
  if (!ids.length) return null;
  const holding = (s: Set<string>) => list.filter((item) => refOfItem(item).stableIds?.some((x) => s.has(x)));
  const any = holding(new Set(ids));
  if (any.length <= 1) return any[0] ?? null;
  const last = holding(new Set([ids[ids.length - 1]]));
  return last.length === 1 ? last[0] : null;
}

/** `locateBy` over a family's nodes: the rule a reload, an opened day turn and a day refresh carry a selection by. */
export const locate = (nodes: Iterable<TurnNode>, ref: NodeRef): TurnNode | null => locateBy(nodes, refOf, ref);

/** Why a fork whose point no longer resolves was refused. */
export const FORK_POINT_GONE =
  "That turn changed on disk after it was drawn, or is gone. Select it again once the tree has refreshed, then fork.";

/** A family's members as the welcome list shows them: every one but the root, newest first. */
export function forkSummaries(members: MemberInfo[], rootId: string): ForkSummary[] {
  return members
    .filter((m) => m.id !== rootId)
    .map(({ id, title, activeAt, cwd }) => ({ id, title, activeAt, cwd }))
    .sort((a, b) => b.activeAt - a.activeAt);
}

export function countBranchPoints(children: Map<string, TurnNode[]>): number {
  let n = 0;
  for (const [key, kids] of children) {
    if (key !== ROOT_KEY && kids.length > 1) n++;
  }
  return n;
}

// ------------------------------------------------------------------ cost

export interface CostBreakdown {
  /** input + cache_creation + cache_read. `input_tokens` alone is the uncached remainder. */
  promptTokens: number;
  outputTokens: number;
  cacheHitRate: number;
}

/**
 * Token weight for a turn, read straight from the transcript's `message.usage`.
 *
 * Deliberately not a dollar figure: the transcript records token counts, not
 * pricing, and on a Max subscription there is no per-token bill to report.
 */
export function costOf(node: TurnNode | undefined): CostBreakdown {
  const empty: CostBreakdown = { promptTokens: 0, outputTokens: 0, cacheHitRate: 0 };
  if (!node?.usage) return empty;
  const u: UsageSnapshot = node.usage;
  const promptTokens =
    u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  return {
    promptTokens,
    outputTokens: u.output_tokens,
    cacheHitRate: promptTokens > 0 ? u.cache_read_input_tokens / promptTokens : 0,
  };
}

/**
 * Context at a point in the tree: the nearest usage-bearing turn's LAST API
 * call, prompt + output (see TurnNode.lastUsage — the summed `usage` of a
 * merged turn over-counts context, one replay per call). This is what the next
 * message from here sends.
 */
export function contextAt(id: NodeId | null, nodes: NodeMap): number | null {
  const seen = new Set<NodeId>();
  let cur = id ? nodes.get(id) : undefined;
  while (cur) {
    const u = cur.lastUsage ?? cur.usage;
    if (u) {
      return (
        u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens +
        u.output_tokens
      );
    }
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
  }
  return null;
}

/**
 * The session's context window. Transcripts record no window size and the
 * model ids carry no marker, so it is inferred from usage: a conversation that
 * exceeds 200k must be on a 1M window. (A 1M session that never crossed 200k
 * reads as 200k — conservative, never past 100%.)
 */
export function inferWindow(nodes: TurnNode[]): number {
  let max = 0;
  for (const n of nodes) {
    const u = n.lastUsage ?? n.usage;
    if (!u) continue;
    const ctx =
      u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens +
      u.output_tokens;
    if (ctx > max) max = ctx;
  }
  return max > 200_000 ? 1_000_000 : 200_000;
}

export function sumCost(nodes: TurnNode[]): CostBreakdown {
  return nodes.reduce<CostBreakdown>(
    (acc, n) => {
      const c = costOf(n);
      acc.promptTokens += c.promptTokens;
      acc.outputTokens += c.outputTokens;
      return acc;
    },
    { promptTokens: 0, outputTokens: 0, cacheHitRate: 0 },
  );
}

// ------------------------------------------------------------------ paths

/**
 * A working directory as a comparison key, never for display. One session
 * records the same folder as `c:\…`, `C:\…` and `/c/…` (Git Bash), with or
 * without a trailing separator; all of them are one directory. Only the
 * drive letter is case-folded — the rest of a path can be case-sensitive.
 */
export function cwdKey(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(s);
  if (msys) s = `${msys[1]}:/${s.slice(3)}`;
  s = s.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  s = s.replace(/\/+$/, "");
  // A bare root keeps its separator: "c:/" and "/" are directories too.
  return /^[a-z]:$/.test(s) ? `${s}/` : s || (p.trim() ? "/" : "");
}

// ------------------------------------------------------------------ text

export function shortLabel(node: TurnNode, max = 48): string {
  if (node.label) return node.label;
  const t = node.text.replace(/\s+/g, " ").trim();
  if (!t) {
    if (node.toolUses?.length) return `⚒ ${node.toolUses.join(", ")}`;
    return node.role === "assistant" ? "(thinking only)" : "(empty)";
  }
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
