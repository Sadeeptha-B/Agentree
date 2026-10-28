import type { DayChat, DayTurn } from "../shared/types.ts";
import { laneKey, turnKey } from "./day.ts";

/**
 * Geometry of the day view: one lane per chat session, time running left to
 * right on ONE axis shared by every lane, so turns drawn one above the other
 * happened at (about) the same time.
 *
 * The axis is compressed time. Spacing follows the clock, capped so one slow
 * reply doesn't stretch the day, and never closer than `MIN_GAP` within a
 * track, so a burst of turns doesn't pile up. A pause of `IDLE_BREAK` or more
 * collapses into a fixed-width break that says how long it was.
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
/** Closest two turns of one track may be, centre to centre. */
export const MIN_GAP = 16;
export const PX_PER_MIN = 6;
/** Longest step between two consecutive turns that aren't a break. */
export const MAX_STEP = 120;
/** A pause at least this long is drawn as a break, not to scale. */
export const IDLE_BREAK = 20 * 60_000;
export const BREAK_W = 56;
/** Closest two time labels may be. */
const TICK_SPACE = 44;
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
  /** Idle time, ms. */
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

export function buildDayLayout(turns: DayTurn[], chats: DayChat[]): DayLayout {
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
    const height = LANE_PAD * 2 + tracks * TRACK_H;
    lanes.push({ key: laneKey(chat), chat, familyStart, top: y, height, tracks, turns: [] });
    y += height;
  });

  // The axis: one pass in time order over every lane.
  const dots: DayDot[] = [];
  const byKey = new Map<string, DayDot>();
  const breaks: DayBreak[] = [];
  const lastX = new Map<string, number>();
  let prev: DayDot | null = null;
  for (const t of drawn) {
    const key = turnKey(t);
    const lane = laneOf.get(laneKey(t))!;
    const track = trackOf.get(key)!;
    const slot = `${lane}:${track}`;
    let x = PAD;
    let idle = 0;
    if (prev) {
      const dt = t.timestamp - prev.turn.timestamp;
      if (dt >= IDLE_BREAK) {
        idle = dt;
        x = prev.x + BREAK_W;
      } else {
        x = prev.x + Math.min(MAX_STEP, (dt / 60_000) * PX_PER_MIN);
      }
    }
    const held = lastX.get(slot);
    if (held !== undefined) x = Math.max(x, held + MIN_GAP);
    if (idle && prev) breaks.push({ x0: prev.x, x1: x, ms: idle });
    lastX.set(slot, x);
    const dot: DayDot = {
      key,
      turn: t,
      lane,
      track,
      x,
      y: lanes[lane].top + LANE_PAD + TRACK_H * (track + 0.5),
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
  return { lanes, dots, byKey, edges, breaks, ticks: ticksFor(dots), width, height: y + PAD };
}

/**
 * Time labels: the first turn, the first turn after each break, and each
 * hour, placed by interpolating between the two turns it falls between (never
 * inside a break, which is labelled with its length instead). A label too
 * close to the one before it is dropped; hours yield to the other two.
 */
function ticksFor(dots: DayDot[]): DayTick[] {
  const raw: DayTick[] = [];
  for (let i = 0; i < dots.length; i++) {
    const b = dots[i];
    if (i === 0) {
      raw.push({ x: b.x, t: b.turn.timestamp, kind: "start" });
      continue;
    }
    const a = dots[i - 1];
    const dt = b.turn.timestamp - a.turn.timestamp;
    if (dt >= IDLE_BREAK) {
      raw.push({ x: b.x, t: b.turn.timestamp, kind: "resume" });
      continue;
    }
    for (let h = nextHour(a.turn.timestamp); h <= b.turn.timestamp; h = nextHour(h)) {
      raw.push({ x: a.x + ((b.x - a.x) * (h - a.turn.timestamp)) / dt, t: h, kind: "hour" });
    }
  }
  const out: DayTick[] = [];
  for (const t of raw) {
    const last = out[out.length - 1];
    if (last && t.x - last.x < TICK_SPACE) {
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

/** A chat's latest turn of the day: where clicking its lane lands. */
export const laneLatest = (lane: DayLane): string | null => lane.turns[lane.turns.length - 1] ?? null;
