import { cwdKey } from "../shared/render.ts";
import type { DayActivity, DayChat, ProviderId, SessionMeta } from "../shared/types.ts";

/**
 * The day view's rules, kept apart from the component so they can be tested
 * without a DOM. A day is the renderer's LOCAL calendar day, named by its
 * `YYYY-MM-DD` key.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** The key of the local day holding `t` (epoch ms). */
export const dayKeyOf = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const todayKey = (): string => dayKeyOf(Date.now());

/** The year, month (0-based) and day a key names; null for anything else. */
function parts(key: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const t = new Date(y, mo, d);
  return t.getFullYear() === y && t.getMonth() === mo && t.getDate() === d ? [y, mo, d] : null;
}

export const isDayKey = (key: string): boolean => parts(key) !== null;

/**
 * `[start, end)` of a local day, in epoch ms: midnight to the next midnight,
 * by the calendar rather than by adding 24 hours, so a day the clocks change
 * on is 23 or 25 hours long.
 */
export function dayBounds(key: string): { start: number; end: number } {
  const p = parts(key) ?? parts(todayKey())!;
  return { start: new Date(p[0], p[1], p[2]).getTime(), end: new Date(p[0], p[1], p[2] + 1).getTime() };
}

/** The day `n` days after `key` (before, for a negative `n`). */
export function shiftDay(key: string, n: number): string {
  const p = parts(key) ?? parts(todayKey())!;
  return dayKeyOf(new Date(p[0], p[1], p[2] + n).getTime());
}

/** "Wed, Oct 28, 2026", in the user's locale. */
export const dayTitle = (key: string): string =>
  new Date(dayBounds(key).start).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/** "14:05" in the user's locale. */
export const clock = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** The local day of the newest activity among `sessions`, or null when there is none. */
export function latestActiveDay(sessions: SessionMeta[]): string | null {
  let latest = 0;
  for (const s of sessions) if (s.activeAt > latest) latest = s.activeAt;
  return latest > 0 ? dayKeyOf(latest) : null;
}

export interface DayFilter {
  query: string;
  /** A `cwdKey`, or "" for every directory. */
  cwd: string;
  provider: ProviderId | "";
}

/** Whether a lane passes the welcome screen's filters: its own directory, agent and search. */
function laneMatches(c: DayChat, f: DayFilter, q: string): boolean {
  if (f.provider && c.provider !== f.provider) return false;
  // The lane's OWN directory: a fork made in another repo shows under that repo.
  if (f.cwd && cwdKey(c.cwd) !== f.cwd) return false;
  if (!q) return true;
  return (
    c.title.toLowerCase().includes(q) ||
    c.familyTitle.toLowerCase().includes(q) ||
    c.cwd.toLowerCase().includes(q) ||
    c.sessionId.startsWith(q) ||
    c.familyId.startsWith(q)
  );
}

/** The day as shown: only the lanes the filters let through, and their turns. */
export function filterDay(day: DayActivity, f: DayFilter): DayActivity {
  const q = f.query.trim().toLowerCase();
  if (!q && !f.cwd && !f.provider) return day;
  const chats = day.chats.filter((c) => laneMatches(c, f, q));
  const keep = new Set(chats.map((c) => laneKey(c)));
  return { ...day, chats, turns: day.turns.filter((t) => keep.has(laneKey(t))) };
}

/** A lane's identity: session ids are unique per agent, not across agents. */
export const laneKey = (x: { provider: ProviderId; sessionId: string }): string => `${x.provider}:${x.sessionId}`;

/**
 * A turn's identity in the day: node ids are unique within a family, and a
 * day holds many families of several agents.
 */
export const turnKey = (t: { provider: ProviderId; familyId: string; id: string }): string =>
  `${t.provider}:${t.familyId}:${t.id}`;
