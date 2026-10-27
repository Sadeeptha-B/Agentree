import { cwdKey } from "../shared/render.ts";
import type { ProviderId, SessionMeta } from "../shared/types.ts";

/**
 * The welcome list's filtering and directory rail, kept apart from the
 * component so the rules can be tested without a DOM.
 */

/** The directories a family belongs to, as recorded, one per distinct `cwdKey`. */
export function dirsOf(s: SessionMeta): string[] {
  const out = new Map<string, string>();
  for (const d of [s.cwd]) if (d && !out.has(cwdKey(d))) out.set(cwdKey(d), d);
  return [...out.values()];
}

export interface RailDir {
  /** `cwdKey` — what the filter stores and compares. */
  key: string;
  /** Shown as recorded, in the spelling of the directory's most recent session. */
  path: string;
  n: number;
}

/** Directories ranked by their most recent conversation, so the rail reads in the list's order. */
export function railDirs(sessions: SessionMeta[]): RailDir[] {
  const dirs = new Map<string, RailDir & { latest: number }>();
  for (const s of sessions) {
    for (const path of dirsOf(s)) {
      const key = cwdKey(path);
      const d = dirs.get(key);
      if (!d) dirs.set(key, { key, path, n: 1, latest: s.activeAt });
      else {
        d.n++;
        if (s.activeAt > d.latest) {
          d.latest = s.activeAt;
          d.path = path;
        }
      }
    }
  }
  return [...dirs.values()].sort((a, b) => b.latest - a.latest).map(({ key, path, n }) => ({ key, path, n }));
}

export interface ListFilter {
  query: string;
  /** A `cwdKey`, or "" for every directory. */
  cwd: string;
  /** One agent, or "" for all of them. */
  provider: ProviderId | "";
}

/** The sessions of the selected agent — what the rail counts and the list draws from. */
export const ofProvider = (sessions: SessionMeta[], provider: ProviderId | "") =>
  provider ? sessions.filter((s) => s.provider === provider) : sessions;

/** The list as shown: filtered, newest activity first. */
export function filterSessions(sessions: SessionMeta[], f: ListFilter): SessionMeta[] {
  const q = f.query.trim().toLowerCase();
  const list = ofProvider(sessions, f.provider).filter((s) => {
    if (f.cwd && !dirsOf(s).some((d) => cwdKey(d) === f.cwd)) return false;
    if (!q) return true;
    return s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.startsWith(q);
  });
  // `listSessions` already sorts this way, but the ordering is the point of
  // the screen, so don't rely on it holding.
  return [...list].sort((a, b) => b.activeAt - a.activeAt);
}
