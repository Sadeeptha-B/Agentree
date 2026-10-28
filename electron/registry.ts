import { endOf, FORK_POINT_GONE, refOf, resolveForkPoint } from "../shared/render.ts";
import type {
  DayActivity,
  DayChat,
  DayRun,
  DayTurn,
  ForkPoint,
  ForkResult,
  NodeMeta,
  ProviderHealth,
  ProviderId,
  SessionDetail,
  SessionId,
  SessionMeta,
  TurnNode,
} from "../shared/types.ts";
import {
  claudeHealth,
  claudeWatchDirs,
  listSessions as listClaude,
  loadSession as loadClaude,
  locate as locateClaude,
} from "./transcripts.ts";
import { forkClaudeAt } from "./providers/claude-fork.ts";
import { codexHealth, forkCodexAt, listCodexSessions, loadCodexSession, locateCodex } from "./providers/codex.ts";
import {
  copilotHealth,
  forkCopilotAt,
  listCopilotSessions,
  loadCopilotSession,
  locateCopilot,
} from "./providers/copilot.ts";
import { writeAnnotation } from "./meta.ts";
import { READ_ONLY_STORES, storesReadOnly } from "./readonly.ts";
import { readSettings } from "./settings.ts";
import { claudeProjects, codexArchived, codexIndex, codexSessions, copilotState } from "./paths.ts";
import type { WatchTarget } from "./watch.ts";

/**
 * One surface over the harnesses. Everything above this file sees only
 * `TurnNode[]` and `SessionMeta`; everything below it is one store's reality.
 *
 * Session ids are uuids in all three stores, so routing is "whoever owns the
 * id", asked in order of lookup cost. A provider must never throw out of
 * `list` — a broken harness shows up in `health`, and the others still list.
 *
 * Nothing below `main.ts` / `preload.ts` may import Electron: the VS Code
 * extension bundles this file as-is.
 */
export interface Provider {
  id: ProviderId;
  list(): SessionMeta[];
  /** The family containing `sessionId`, stitched into one tree. */
  load(sessionId: SessionId): SessionDetail | null;
  /** Fork after the node that still ends where `point` did (`resolveForkPoint`). */
  fork(familyId: SessionId, point: ForkPoint): ForkResult | Promise<ForkResult>;
  owns(sessionId: SessionId): boolean;
  health(): ProviderHealth;
  /**
   * What the live view must watch: the files of `sessionId`'s family, or —
   * with null — everything the welcome list is read from.
   */
  watchTargets(sessionId: SessionId | null): WatchTarget[];
}

const codexTargets = (): WatchTarget[] => [
  { kind: "dir", path: codexSessions(), poll: true },
  { kind: "dir", path: codexArchived(), poll: true },
  // Renaming a thread in Codex touches only this file.
  { kind: "file", path: codexIndex() },
];
const copilotTargets = (): WatchTarget[] => [{ kind: "dir", path: copilotState(), poll: true }];

const claude: Provider = {
  id: "claude",
  list: listClaude,
  load: loadClaude,
  fork: forkClaudeAt,
  owns: (id) => locateClaude(id) !== null,
  health: claudeHealth,
  // Every project directory a member of the family lives in: a tree grows
  // through any member, or through a fork file that didn't exist when the
  // view opened (written next to its source).
  watchTargets: (id) =>
    id === null
      ? [{ kind: "dir", path: claudeProjects(), poll: false }]
      : claudeWatchDirs(id).map((d) => ({ kind: "dir", path: d, poll: false })),
};

const codex: Provider = {
  id: "codex",
  list: listCodexSessions,
  load: loadCodexSession,
  fork: forkCodexAt,
  owns: (id) => locateCodex(id) !== null,
  health: codexHealth,
  watchTargets: codexTargets,
};

const copilot: Provider = {
  id: "copilot",
  list: listCopilotSessions,
  load: loadCopilotSession,
  fork: (familyId, point) => {
    // Copilot trees are stitched from linear sessions, and a merged turn spans
    // several raw events — the fork anchors on the LAST one (lastRawId).
    const detail = loadCopilotSession(familyId);
    const node = detail && resolveForkPoint(detail.nodes, point);
    if (!detail || !node) return { ok: false, error: FORK_POINT_GONE };
    return forkCopilotAt(detail.meta.id, node.lastRawId ?? node.id);
  },
  owns: (id) => locateCopilot(id) !== null || loadCopilotSession(id) !== null,
  health: copilotHealth,
  watchTargets: copilotTargets,
};

export const PROVIDERS: Provider[] = [claude, codex, copilot];

export const providerById = (id: ProviderId): Provider | undefined =>
  PROVIDERS.find((p) => p.id === id);

/**
 * The agents the settings say to scan. One turned off isn't scanned, listed,
 * opened or watched at all — unlike the list's agent chips, which only filter.
 */
const enabled = (): Provider[] => {
  const on = readSettings().providers;
  return PROVIDERS.filter((p) => on[p.id] !== false);
};

function guarded<T>(p: Provider, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    console.error(`[agentree] ${p.id} provider failed:`, e);
    failures.set(p.id, e instanceof Error ? e.message : String(e));
    return fallback;
  }
}
const failures = new Map<ProviderId, string>();

export function listAllSessions(): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const p of enabled()) {
    failures.delete(p.id);
    out.push(...guarded(p, () => p.list(), []));
  }
  return dedupeSessions(out).sort((a, b) => b.activeAt - a.activeAt);
}

/**
 * One entry per `provider:id`, whatever a provider returned. Two entries with
 * one identity mean a provider regressed (the Claude moved-repo duplicate did
 * exactly this): the newer is kept and the other is logged, because the user
 * should never see a duplicate — two list cards with one key also left stale
 * cards on screen when the list was filtered.
 */
export function dedupeSessions(list: SessionMeta[]): SessionMeta[] {
  const byKey = new Map<string, SessionMeta>();
  for (const s of list) {
    const key = `${s.provider}:${s.id}`;
    const prev = byKey.get(key);
    if (prev) console.warn(`[agentree] ${key} was listed twice; keeping the newer entry.`);
    if (!prev || s.activeAt > prev.activeAt) byKey.set(key, s);
  }
  return [...byKey.values()];
}

export function allHealth(): ProviderHealth[] {
  return enabled().map((p) => {
    const h = guarded(p, () => p.health(), null);
    const err = failures.get(p.id);
    const base: ProviderHealth = h ?? {
      provider: p.id,
      root: "",
      present: true,
      filesSeen: 0,
      skipped: 0,
      sessionsParsed: 0,
      failed: 0,
      listed: 0,
      formatVersions: {},
      unknownRecordTypes: {},
      backend: "raw",
      warnings: [],
    };
    return err ? { ...base, error: `Provider crashed: ${err}` } : base;
  });
}

function owner(id: SessionId): Provider | undefined {
  return enabled().find((p) => guarded(p, () => p.owns(id), false));
}

export function loadAnySession(id: SessionId): SessionDetail | null {
  const p = owner(id);
  return p ? guarded(p, () => p.load(id), null) : null;
}

export async function forkAnyAt(sessionId: SessionId, point: ForkPoint): Promise<ForkResult> {
  // Every fork, of every agent, comes through here: the one place a write
  // into an agent's store can be refused.
  if (storesReadOnly()) return { ok: false, error: READ_ONLY_STORES };
  const p = owner(sessionId);
  if (!p) return { ok: false, error: "That session is no longer on disk." };
  try {
    return await p.fork(sessionId, point);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Annotate one turn of a family. Loads the family so the annotation can be
 * written under every id the turn has, into every member's sidecar — see
 * `writeAnnotation`. Costs one family load per click, which is the point:
 * identity is only known once the family is stitched. Throws when nothing
 * was written, or a sidecar write failed, so the view never shows an
 * annotation as saved that isn't.
 */
export function annotate(familyId: SessionId, nodeId: string, patch: NodeMeta): void {
  const p = owner(familyId);
  const detail = p ? guarded(p, () => p.load(familyId), null) : null;
  const node = detail?.nodes.find((n) => n.id === nodeId);
  if (!detail || !node) throw new Error("That turn is no longer in this conversation.");
  const members = detail.members.length ? detail.members.map((m) => m.id) : [detail.meta.id];
  writeAnnotation(node, detail.nodes, [detail.meta.id, ...members], patch);
}

/**
 * What the live view of `sessionId` (or, with null, the welcome screen) has to
 * watch. Resolving an id to its files can mean a scan, so this runs with the
 * providers in the backend; the host only watches the result. Only enabled
 * providers are asked — a disabled one isn't read or watched at all. For the
 * list, one that fails leaves the others' targets intact; for a session, only
 * its owner is asked, and a failure reaches the host, which retries.
 */
export function watchTargets(sessionId: SessionId | null): WatchTarget[] {
  if (sessionId === null) return enabled().flatMap((p) => guarded(p, () => p.watchTargets(null), []));
  return owner(sessionId)?.watchTargets(sessionId) ?? [];
}

// ------------------------------------------------------------------ day view

/** Longest preview a day turn carries; the tree has the full text. */
const PREVIEW_MAX = 400;

function previewOf(n: TurnNode): string {
  const t = n.text.replace(/\s+/g, " ").trim();
  if (t) return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX - 1) + "…" : t;
  if (n.toolUses?.length) return `⚒ ${n.toolUses.join(", ")}`;
  return n.role === "assistant" ? "(thinking only)" : "(empty)";
}

/** A family's part of one day: its lanes, turns and the turns still running into it. */
interface DayPart {
  chats: DayChat[];
  turns: DayTurn[];
  running: DayRun[];
}

/**
 * The turns of `detail` that started in `[start, end)`, each in the lane of
 * the session that owns it — drawn once, as in the tree — and the ones that
 * started earlier and were still running at `start`.
 */
export function dayPart(detail: SessionDetail, start: number, end: number): DayPart {
  const { meta, members } = detail;
  const turns: DayTurn[] = [];
  const running: DayRun[] = [];
  for (const n of detail.nodes) {
    if (n.timestamp > 0 && n.timestamp < start && endOf(n) >= start) {
      running.push({ provider: meta.provider, familyId: meta.id, sessionId: n.sourceSessionId ?? meta.id, start: n.timestamp, end: endOf(n) });
    }
    if (!(n.timestamp >= start && n.timestamp < end)) continue;
    turns.push({
      id: n.id,
      ref: refOf(n),
      parentId: n.parentId,
      sessionId: n.sourceSessionId ?? meta.id,
      familyId: meta.id,
      provider: meta.provider,
      role: n.role,
      preview: previewOf(n),
      timestamp: n.timestamp,
      ...(n.endedAt && n.endedAt > n.timestamp ? { endedAt: n.endedAt } : {}),
      ...(n.branchKind ? { branchKind: n.branchKind } : {}),
      ...(n.isSidechain ? { isSidechain: true } : {}),
      ...(n.midTurn || n.injected ? { midTurn: true } : {}),
    });
  }
  const lanes = [...new Set([...turns, ...running].map((t) => t.sessionId))];
  const chats = lanes.map((id): DayChat => {
    const m = members.find((x) => x.id === id);
    const parent = m?.parentId ? members.find((x) => x.id === m.parentId) : undefined;
    return {
      provider: meta.provider,
      familyId: meta.id,
      sessionId: id,
      title: m?.title ?? meta.title,
      familyTitle: meta.title,
      cwd: m?.cwd ?? meta.cwd,
      parentSessionId: m?.parentId ?? null,
      ...(parent ? { parentTitle: parent.title } : {}),
      ...(m?.parentEvidence ? { parentEvidence: m.parentEvidence } : {}),
      ...((m ? m.archived : meta.archived) ? { archived: true } : {}),
    };
  });
  return { chats, turns, running };
}

/**
 * Each family's day part, by its `revision`: a family nothing was written to
 * since is not reloaded — a live session rewrites one family, and the day
 * view refreshes on every write. The revision covers every file and index a
 * load reads (their paths too, so a moved store is a new key); a family a
 * provider gives no revision for is reloaded every time. Cleared when the
 * window changes.
 */
const dayParts = new Map<string, DayPart>();
let dayWindow = "";

/**
 * Every turn that started in `[start, end)`, across the enabled agents. A
 * family is loaded only when its records can reach the window: none of them
 * is newer than `touchedAt`, and none older than `startedAt` (when known).
 */
export function dayActivity(start: number, end: number): DayActivity {
  if (`${start}:${end}` !== dayWindow || dayParts.size > 500) {
    dayParts.clear();
    dayWindow = `${start}:${end}`;
  }
  const chats: DayChat[] = [];
  const turns: DayTurn[] = [];
  const running: DayRun[] = [];
  const seen = new Set<string>();
  const live = new Set<string>();
  for (const p of enabled()) {
    for (const m of guarded(p, () => p.list(), [])) {
      if (m.touchedAt < start || (m.startedAt || 0) >= end) continue;
      const key = m.revision ? `${p.id}:${m.id}:${m.revision}` : null;
      if (key) live.add(key);
      let part = key ? dayParts.get(key) : undefined;
      if (!part) {
        const detail = guarded(p, () => p.load(m.id), null);
        if (!detail) continue;
        part = dayPart(detail, start, end);
        if (key) dayParts.set(key, part);
      }
      for (const c of part.chats) {
        const k = `${c.provider}:${c.sessionId}`;
        if (!seen.has(k)) {
          seen.add(k);
          chats.push(c);
        }
      }
      turns.push(...part.turns);
      running.push(...part.running);
    }
  }
  for (const key of dayParts.keys()) if (!live.has(key)) dayParts.delete(key);
  turns.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { start, end, chats, turns, running };
}
