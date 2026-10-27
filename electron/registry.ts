import type {
  ForkResult,
  NodeMeta,
  ProviderHealth,
  ProviderId,
  SessionDetail,
  SessionId,
  SessionMeta,
} from "../shared/types.ts";
import {
  claudeHealth,
  claudeResumeArgv,
  claudeWatchDirs,
  listSessions as listClaude,
  loadSession as loadClaude,
  locate as locateClaude,
} from "./transcripts.ts";
import { forkClaudeAt } from "./providers/claude-fork.ts";
import { codexHealth, codexResumeArgv, forkCodexAt, listCodexSessions, loadCodexSession, locateCodex } from "./providers/codex.ts";
import {
  copilotHealth,
  copilotResumeArgv,
  forkCopilotAt,
  listCopilotSessions,
  loadCopilotSession,
  locateCopilot,
} from "./providers/copilot.ts";
import { writeAnnotation } from "./meta.ts";
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
  fork(familyId: SessionId, nodeId: string): ForkResult | Promise<ForkResult>;
  owns(sessionId: SessionId): boolean;
  health(): ProviderHealth;
  /** argv that resumes a session in the harness's CLI. */
  resumeArgv(sessionId: SessionId): string[];
}

const claude: Provider = {
  id: "claude",
  list: listClaude,
  load: loadClaude,
  fork: forkClaudeAt,
  owns: (id) => locateClaude(id) !== null,
  health: claudeHealth,
  resumeArgv: claudeResumeArgv,
};

const codex: Provider = {
  id: "codex",
  list: listCodexSessions,
  load: loadCodexSession,
  fork: forkCodexAt,
  owns: (id) => locateCodex(id) !== null,
  health: codexHealth,
  resumeArgv: codexResumeArgv,
};

const copilot: Provider = {
  id: "copilot",
  list: listCopilotSessions,
  load: loadCopilotSession,
  fork: (familyId, nodeId) => {
    // Copilot trees are stitched from linear sessions, and a merged turn spans
    // several raw events — the fork anchors on the LAST one (lastRawId).
    const detail = loadCopilotSession(familyId);
    const node = detail?.nodes.find((n) => n.id === nodeId);
    if (!detail || !node) return { ok: false, error: "That turn is not in this session." };
    return forkCopilotAt(detail.meta.id, node.lastRawId ?? node.id);
  },
  owns: (id) => locateCopilot(id) !== null || loadCopilotSession(id) !== null,
  health: copilotHealth,
  resumeArgv: copilotResumeArgv,
};

export const PROVIDERS: Provider[] = [claude, codex, copilot];

export const providerById = (id: ProviderId): Provider | undefined =>
  PROVIDERS.find((p) => p.id === id);

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
  for (const p of PROVIDERS) {
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
  return PROVIDERS.map((p) => {
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
  return PROVIDERS.find((p) => guarded(p, () => p.owns(id), false));
}

export function loadAnySession(id: SessionId): SessionDetail | null {
  const p = owner(id);
  return p ? guarded(p, () => p.load(id), null) : null;
}

export async function forkAnyAt(sessionId: SessionId, nodeId: string): Promise<ForkResult> {
  const p = owner(sessionId);
  if (!p) return { ok: false, error: "That session is no longer on disk." };
  try {
    return await p.fork(sessionId, nodeId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Annotate one turn of a family. Loads the family so the annotation can be
 * written under every id the turn has, into every member's sidecar — see
 * `writeAnnotation`. Costs one family load per click, which is the point:
 * identity is only known once the family is stitched.
 */
export function annotate(familyId: SessionId, nodeId: string, patch: NodeMeta): void {
  const p = owner(familyId);
  const detail = p ? guarded(p, () => p.load(familyId), null) : null;
  const node = detail?.nodes.find((n) => n.id === nodeId);
  if (!detail || !node) return;
  const members = detail.members.length ? detail.members.map((m) => m.id) : [detail.meta.id];
  writeAnnotation(node, [detail.meta.id, ...members], patch);
}

const codexTargets = (): WatchTarget[] => [
  { kind: "dir", path: codexSessions(), poll: true },
  { kind: "dir", path: codexArchived(), poll: true },
  // Renaming a thread in Codex touches only this file.
  { kind: "file", path: codexIndex() },
];

/**
 * What the live view of `sessionId` (or, with null, the welcome screen) has to
 * watch. Resolving an id to its files can mean a scan, so this runs with the
 * providers in the backend; the host only watches the result.
 */
export function watchTargets(sessionId: SessionId | null): WatchTarget[] {
  if (sessionId === null) {
    return [
      { kind: "dir", path: claudeProjects(), poll: false },
      ...codexTargets(),
      { kind: "dir", path: copilotState(), poll: true },
    ];
  }
  // Every project directory a member of the family lives in: a tree grows
  // through any member, or through a fork file that didn't exist when the
  // view opened (written next to its source).
  const dirs = claudeWatchDirs(sessionId);
  if (dirs.length) return dirs.map((d) => ({ kind: "dir", path: d, poll: false }));
  if (locateCodex(sessionId)) return codexTargets();
  if (locateCopilot(sessionId)) return [{ kind: "dir", path: copilotState(), poll: true }];
  return [];
}
