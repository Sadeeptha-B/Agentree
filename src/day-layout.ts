import { activeEndOf, endOf } from "../shared/render.ts";
import type { DayChat, DayRun, DayTurn } from "../shared/types.ts";
import { chatName, laneKey, turnKey } from "./day.ts";

/**
 * Geometry of the day view: one lane per chat session, time running left to
 * right on ONE axis shared by every lane, so turns drawn one above the other
 * happened at (about) the same time.
 *
 * The axis is compressed time. Spacing follows the clock, capped so one slow
 * reply doesn't stretch the day, and never closer than `MIN_GAP` within a
 * track, so a burst of turns doesn't pile up. A pause of `IDLE_BREAK` or more
 * with no recorded activity — measured from the latest activity under every
 * earlier turn (`activeEndOf`: its end, or the tool calls and results that
 * followed it), so an agent working through a long reply or a tool loop is
 * not idle — collapses into a fixed-width break that says how long it was.
 *
 * Zoom is time-only: x is scaled by the view, y never is. A lane is as tall
 * as its tracks or its chat's wrapped name (and folder), whichever needs
 * more, in screen pixels — so the name is readable whole at any zoom.
 */

export const PAD = 40;
/** Room above the first lane for the time labels. */
export const AXIS_H = 30;
export const TRACK_H = 22;
/** Space inside a lane, above its first track and below its last. */
export const LANE_PAD = 8;
/** Extra space between two families' lanes. */
export const FAMILY_GAP = 10;
/** Radius of a drawn turn, unselected. */
export const DOT_R = 6;

/** Screen width of the pinned column of chat names. */
export const LABEL_W = 200;
/** Line height of a wrapped chat name. */
export const LABEL_LINE_H = 16;
/** Room for a name's text in the column: less the agent dot, the turn count and padding (and ⑂ for a fork). */
const LABEL_TEXT_W = LABEL_W - 64;
const FORK_GLYPH_W = 14;
/**
 * Width of a character of a 12px name, generously: under-measuring would let
 * it overflow its lane. Most scripts fit in 7px; CJK, Hangul, fullwidth forms
 * and emoji are drawn a whole em wide.
 */
const LABEL_CHAR_W = 7;
const LABEL_WIDE_W = 12;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6\p{Extended_Pictographic}]/u;
const charW = (c: string) => (WIDE.test(c) ? LABEL_WIDE_W : LABEL_CHAR_W);

/**
 * How many lines a chat's name wraps to in the label column, estimated as
 * the tree estimates its boxes (nothing can be measured before it is
 * drawn): words wrap whole, a word longer than a line breaks anywhere — as
 * the browser breaks CJK, which has no spaces, between any two characters.
 */
export function labelLines(chat: DayChat): number {
  const width = LABEL_TEXT_W - (chat.parentSessionId ? FORK_GLYPH_W : 0);
  const space = LABEL_CHAR_W;
  let lines = 1;
  let used = 0;
  for (const word of chatName(chat).split(/\s+/).filter(Boolean)) {
    const chars = [...word].map(charW);
    const w = chars.reduce((a, b) => a + b, 0);
    if (used > 0 && used + space + w <= width) {
      used += space + w;
      continue;
    }
    if (used > 0) lines++;
    used = 0;
    // Too long for a line of its own: broken anywhere, character by character.
    for (const c of chars) {
      if (used > 0 && used + c > width) {
        lines++;
        used = 0;
      }
      used += c;
    }
  }
  return lines;
}

/**
 * Drawn radius of a turn at zoom `k`. Zoom spreads turns apart only in x, so
 * a dot shrinks as they close up: two turns of one track, `MIN_GAP * k`
 * apart, stay clear of each other down to the 2px floor (k ≈ 0.375).
 */
export const dotRadius = (k: number): number => Math.max(2, Math.min(DOT_R, (MIN_GAP * k - 2) / 2));
/** Closest two turns of one track may be, centre to centre. */
export const MIN_GAP = 16;
export const PX_PER_MIN = 6;
/** Longest step between two consecutive turns that aren't a break. */
export const MAX_STEP = 120;
/** A pause with nothing running at least this long is drawn as a break, not to scale. */
export const IDLE_BREAK = 20 * 60_000;
export const BREAK_W = 56;
/** Closest two time labels may be, in screen pixels: "12:27 PM" at 10px is about 50 wide. */
const TICK_SPACE = 64;
const HOUR = 3_600_000;

export interface DayLane {
  key: string;
  chat: DayChat;
  /** The family's first lane: a separator is drawn above it. */
  familyStart: boolean;
  top: number;
  height: number;
  tracks: number;
  /** Its turns' keys, oldest first. */
  turns: string[];
}

export interface DayDot {
  key: string;
  turn: DayTurn;
  lane: number;
  track: number;
  x: number;
  y: number;
}

export type DayEdge =
  /** Parent and child both drawn. `cross`: it changes lane, or enters a fork or edited branch. */
  | { kind: "edge"; from: DayDot; to: DayDot; cross: boolean }
  /** The parent is outside the day (or the filters): a stub into the child. */
  | { kind: "lead"; to: DayDot; cross: boolean };

export interface DayBreak {
  x0: number;
  x1: number;
  /** Idle time, ms: from the latest recorded activity of the turns before it to the next start. */
  ms: number;
}

export interface DayTick {
  x: number;
  t: number;
  /** `start`: the first turn; `resume`: the first turn after a break; `hour`: on the hour. */
  kind: "start" | "resume" | "hour";
}

export interface DayLayout {
  lanes: DayLane[];
  dots: DayDot[];
  byKey: Map<string, DayDot>;
  edges: DayEdge[];
  breaks: DayBreak[];
  ticks: DayTick[];
  width: number;
  height: number;
}

/**
 * Lanes in reading order: families by their first turn of the day; within a
 * family the root's lane first, then by first turn.
 */
function orderLanes(chats: DayChat[], first: Map<string, number>): DayChat[] {
  const famFirst = new Map<string, number>();
  for (const c of chats) {
    const f = `${c.provider}:${c.familyId}`;
    const t = first.get(laneKey(c)) ?? Infinity;
    if (t < (famFirst.get(f) ?? Infinity)) famFirst.set(f, t);
  }
  const fam = (c: DayChat) => `${c.provider}:${c.familyId}`;
  return [...chats].sort(
    (a, b) =>
      (famFirst.get(fam(a)) ?? Infinity) - (famFirst.get(fam(b)) ?? Infinity) ||
      (fam(a) < fam(b) ? -1 : fam(a) > fam(b) ? 1 : 0) ||
      Number(a.parentSessionId !== null) - Number(b.parentSessionId !== null) ||
      (first.get(laneKey(a)) ?? Infinity) - (first.get(laneKey(b)) ?? Infinity) ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
}

/**
 * Oldest first; among turns stamped the same instant (a reply recorded in
 * the same millisecond as its prompt), a parent before its child, so the
 * child continues the parent's track instead of starting one.
 */
function timeOrder(turns: DayTurn[]): DayTurn[] {
  const byTime = [...turns].sort(
    (a, b) => a.timestamp - b.timestamp || (turnKey(a) < turnKey(b) ? -1 : turnKey(a) > turnKey(b) ? 1 : 0),
  );
  const out: DayTurn[] = [];
  for (let i = 0; i < byTime.length; ) {
    let j = i;
    while (j < byTime.length && byTime[j].timestamp === byTime[i].timestamp) j++;
    const group = byTime.slice(i, j);
    const inGroup = new Map(group.map((t) => [turnKey(t), t]));
    const placed = new Set<string>();
    const place = (t: DayTurn, seen: Set<string>) => {
      const k = turnKey(t);
      if (placed.has(k) || seen.has(k)) return;
      seen.add(k);
      const parent = t.parentId ? inGroup.get(turnKey({ ...t, id: t.parentId })) : undefined;
      if (parent) place(parent, seen);
      placed.add(k);
      out.push(t);
    };
    for (const t of group) place(t, new Set());
    i = j;
  }
  return out;
}

/**
 * `running`: recorded work with no mark of its own (`DayRun`) — turns from
 * before the window still running in it, work a member recorded on its copy
 * of a shared turn. Nothing is idle while it runs. `dirs`: each lane's name
 * is followed by its directory's last folder, on a line of its own.
 */
export function buildDayLayout(
  turns: DayTurn[],
  chats: DayChat[],
  running: DayRun[] = [],
  { dirs = false }: { dirs?: boolean } = {},
): DayLayout {
  const sorted = timeOrder(turns);
  const first = new Map<string, number>();
  for (const t of sorted) if (!first.has(laneKey(t))) first.set(laneKey(t), t.timestamp);

  // A turn whose chat isn't listed has nowhere to go; a chat with no turn is no lane.
  const ordered = orderLanes(
    chats.filter((c) => first.has(laneKey(c))),
    first,
  );
  const laneOf = new Map(ordered.map((c, i) => [laneKey(c), i]));
  const drawn = sorted.filter((t) => laneOf.has(laneKey(t)));

  // Tracks, as in a git log: a turn continues the track its parent ends;
  // anything else — a second child, a turn whose parent isn't in the lane
  // while the lane already has a track — opens a new one.
  const tails: string[][] = ordered.map(() => []);
  const trackOf = new Map<string, number>();
  for (const t of drawn) {
    const lane = laneOf.get(laneKey(t))!;
    const own = tails[lane];
    const parent = t.parentId ? turnKey({ ...t, id: t.parentId }) : null;
    let track = parent ? own.indexOf(parent) : -1;
    if (track < 0) track = own.length;
    own[track] = turnKey(t);
    trackOf.set(turnKey(t), track);
  }

  // Lanes, top to bottom.
  const lanes: DayLane[] = [];
  let y = AXIS_H;
  ordered.forEach((chat, i) => {
    const familyStart = i === 0 || ordered[i - 1].familyId !== chat.familyId || ordered[i - 1].provider !== chat.provider;
    if (familyStart && i > 0) y += FAMILY_GAP;
    const tracks = Math.max(1, tails[i].length);
    const height = LANE_PAD * 2 + Math.max(tracks * TRACK_H, (labelLines(chat) + (dirs ? 1 : 0)) * LABEL_LINE_H);
    lanes.push({ key: laneKey(chat), chat, familyStart, top: y, height, tracks, turns: [] });
    y += height;
  });

  // The axis: one pass in time order over every lane.
  const dots: DayDot[] = [];
  const byKey = new Map<string, DayDot>();
  const breaks: DayBreak[] = [];
  const lastX = new Map<string, number>();
  /** Turns drawn just after a break: where the time labels resume. */
  const resumed = new Set<string>();
  let prev: DayDot | null = null;
  /**
   * The latest recorded activity of every turn and run started so far, in
   * any lane: until then, an agent was working. Runs join in start order,
   * before the first turn that starts after them.
   */
  let busyUntil = 0;
  const runs = [...running].sort((a, b) => a.start - b.start);
  let nextRun = 0;
  for (const t of drawn) {
    while (nextRun < runs.length && runs[nextRun].start < t.timestamp) busyUntil = Math.max(busyUntil, runs[nextRun++].end);
    const key = turnKey(t);
    const lane = laneOf.get(laneKey(t))!;
    const track = trackOf.get(key)!;
    const slot = `${lane}:${track}`;
    let x = PAD;
    let idle = 0;
    if (prev) {
      const dt = t.timestamp - prev.turn.timestamp;
      if (t.timestamp - busyUntil >= IDLE_BREAK) {
        idle = t.timestamp - busyUntil;
        x = prev.x + BREAK_W;
        resumed.add(key);
      } else {
        x = prev.x + Math.min(MAX_STEP, (dt / 60_000) * PX_PER_MIN);
      }
    }
    const held = lastX.get(slot);
    if (held !== undefined) x = Math.max(x, held + MIN_GAP);
    if (idle && prev) breaks.push({ x0: prev.x, x1: x, ms: idle });
    lastX.set(slot, x);
    busyUntil = Math.max(busyUntil, activeEndOf(t));
    const dot: DayDot = {
      key,
      turn: t,
      lane,
      track,
      x,
      // Tracks centred in a lane its name made taller.
      y: lanes[lane].top + (lanes[lane].height - lanes[lane].tracks * TRACK_H) / 2 + TRACK_H * (track + 0.5),
    };
    dots.push(dot);
    byKey.set(key, dot);
    lanes[lane].turns.push(key);
    prev = dot;
  }

  const edges: DayEdge[] = [];
  for (const d of dots) {
    const t = d.turn;
    if (!t.parentId) continue;
    const from = byKey.get(turnKey({ ...t, id: t.parentId }));
    const cross = !!t.branchKind || (from ? from.lane !== d.lane : false);
    edges.push(from ? { kind: "edge", from, to: d, cross } : { kind: "lead", to: d, cross });
  }

  const width = (dots.length ? dots[dots.length - 1].x : PAD) + PAD;
  return { lanes, dots, byKey, edges, breaks, ticks: ticksFor(dots, resumed), width, height: y + PAD };
}

/**
 * Time labels: the first turn, the first turn after each break, and each
 * hour, placed by interpolating between the two turns it falls between (never
 * inside a break, which is labelled with its length instead). All of them:
 * which fit depends on the zoom (`visibleTicks`).
 */
function ticksFor(dots: DayDot[], resumed: Set<string>): DayTick[] {
  const raw: DayTick[] = [];
  for (let i = 0; i < dots.length; i++) {
    const b = dots[i];
    if (i === 0) {
      raw.push({ x: b.x, t: b.turn.timestamp, kind: "start" });
      continue;
    }
    const a = dots[i - 1];
    const dt = b.turn.timestamp - a.turn.timestamp;
    if (resumed.has(b.key)) {
      raw.push({ x: b.x, t: b.turn.timestamp, kind: "resume" });
      continue;
    }
    for (let h = nextHour(a.turn.timestamp); h <= b.turn.timestamp; h = nextHour(h)) {
      raw.push({ x: a.x + ((b.x - a.x) * (h - a.turn.timestamp)) / dt, t: h, kind: "hour" });
    }
  }
  return raw;
}

/**
 * The time labels that fit at zoom `k`: they are drawn at a fixed size, so
 * one closer than `TICK_SPACE` screen pixels to the one before it is
 * dropped; an hour yields to a first turn or a resume.
 */
export function visibleTicks(ticks: DayTick[], k: number): DayTick[] {
  const out: DayTick[] = [];
  for (const t of ticks) {
    const last = out[out.length - 1];
    if (last && (t.x - last.x) * k < TICK_SPACE) {
      if (t.kind !== "hour" && last.kind === "hour") out[out.length - 1] = t;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** The first local hour boundary after `t`, by the clock (so across a DST change too). */
function nextHour(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime() > t ? d.getTime() : t + HOUR;
}

// ------------------------------------------------------------------ navigation

/** The turn before (`-1`) or after (`1`) `key` in its own chat; null at either end. */
export function stepInLane(layout: DayLayout, key: string, dir: 1 | -1): string | null {
  const d = layout.byKey.get(key);
  if (!d) return null;
  const own = layout.lanes[d.lane].turns;
  return own[own.indexOf(key) + dir] ?? null;
}

/**
 * The turn of the chat above (`-1`) or below (`1`) nearest in time to `key`
 * (the earlier one on a tie); null at the first or last chat.
 */
export function stepLane(layout: DayLayout, key: string, dir: 1 | -1): string | null {
  const d = layout.byKey.get(key);
  const lane = d && layout.lanes[d.lane + dir];
  if (!d || !lane) return null;
  let best: DayDot | null = null;
  for (const k of lane.turns) {
    const c = layout.byKey.get(k)!;
    if (!best || Math.abs(c.turn.timestamp - d.turn.timestamp) < Math.abs(best.turn.timestamp - d.turn.timestamp)) best = c;
  }
  return best?.key ?? null;
}

/**
 * A chat's latest turn of the day by when it ENDED (`endOf`, as the tree
 * ranks its tip; the later-starting on a tie): where clicking its lane
 * lands. ←/→ still step in start order.
 */
export function laneLatest(layout: DayLayout, lane: DayLane): DayDot | null {
  let best: DayDot | null = null;
  for (const k of lane.turns) {
    const d = layout.byKey.get(k)!;
    if (!best || endOf(d.turn) >= endOf(best.turn)) best = d;
  }
  return best;
}
