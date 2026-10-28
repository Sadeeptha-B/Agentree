import { describe, expect, it } from "vitest";
import type { DayChat, DayTurn } from "../shared/types.ts";
import {
  BREAK_W, buildDayLayout, DOT_R, dotRadius, IDLE_BREAK, LABEL_LINE_H, labelLines, LANE_PAD, laneLatest, MIN_GAP,
  stepInLane, stepLane, TRACK_H, visibleTicks, type DayLayout,
} from "./day-layout.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 28, 9, 0);

const chat = (sessionId: string, opts: Partial<DayChat> = {}): DayChat => ({
  provider: "claude",
  familyId: sessionId,
  sessionId,
  title: sessionId,
  familyTitle: sessionId,
  cwd: "/work",
  parentSessionId: null,
  ...opts,
});

const turn = (c: DayChat, id: string, parentId: string | null, minute: number, opts: Partial<DayTurn> = {}): DayTurn => ({
  id,
  ref: { point: { nodeId: id, sessionId: c.sessionId, endId: id } },
  parentId,
  sessionId: c.sessionId,
  familyId: c.familyId,
  provider: c.provider,
  role: "user",
  preview: id,
  timestamp: T0 + minute * MIN,
  ...opts,
});

const dot = (l: DayLayout, id: string) => l.dots.find((d) => d.turn.id === id)!;
const edgeInto = (l: DayLayout, id: string) => l.edges.find((e) => e.to.turn.id === id)!;

describe("day layout", () => {
  it("draws one chat's turns left to right, never closer than the minimum gap", () => {
    const a = chat("A");
    const l = buildDayLayout(
      [turn(a, "q1", null, 0), turn(a, "a1", "q1", 0), turn(a, "q2", "a1", 2), turn(a, "a2", "q2", 3)],
      [a],
    );
    const xs = ["q1", "a1", "q2", "a2"].map((id) => dot(l, id).x);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(MIN_GAP);
    expect(l.lanes).toHaveLength(1);
    expect(l.lanes[0].tracks).toBe(1);
    expect(l.edges.every((e) => e.kind === "edge" && !e.cross)).toBe(true);
  });

  it("collapses a long pause into one labelled break", () => {
    const a = chat("A");
    const l = buildDayLayout([turn(a, "q1", null, 0), turn(a, "q2", "q1", 95)], [a]);
    expect(l.breaks).toEqual([{ x0: dot(l, "q1").x, x1: dot(l, "q2").x, ms: 95 * MIN }]);
    expect(dot(l, "q2").x - dot(l, "q1").x).toBe(BREAK_W);
    expect(l.ticks.map((t) => t.kind)).toEqual(["start", "resume"]);
    // Just under the threshold is drawn to scale (capped), not as a break.
    const near = buildDayLayout([turn(a, "q1", null, 0), turn(a, "q2", "q1", IDLE_BREAK / MIN - 1)], [a]);
    expect(near.breaks).toEqual([]);
  });

  it("is idle only while nothing runs: a long reply is not a pause", () => {
    const a = chat("A");
    const b = chat("B");
    // A reply running 09:00–10:00, then a prompt at 10:01: one idle minute.
    const working = buildDayLayout(
      [turn(a, "q1", null, 0), turn(a, "r1", "q1", 0, { role: "assistant", endedAt: T0 + 60 * MIN }), turn(a, "q2", "r1", 61)],
      [a],
    );
    expect(working.breaks).toEqual([]);
    // The pause is measured from the latest end in ANY lane, and labelled with its length.
    const l = buildDayLayout(
      [
        turn(a, "a1", null, 0, { endedAt: T0 + 50 * MIN }),
        turn(b, "b1", null, 10, { endedAt: T0 + 30 * MIN }),
        turn(b, "b2", "b1", 95),
      ],
      [a, b],
    );
    expect(l.breaks).toEqual([{ x0: dot(l, "b1").x, x1: dot(l, "b2").x, ms: 45 * MIN }]);
    expect(l.ticks.filter((t) => t.kind === "resume").map((t) => t.t)).toEqual([T0 + 95 * MIN]);
  });

  it("is not idle while the agent works after its reply: tool runs count, from `activeUntil`", () => {
    const a = chat("A");
    // One message at 09:01, its tool run until 10:00, the next prompt at 10:01.
    const turns = [
      turn(a, "q1", null, 0),
      turn(a, "r1", "q1", 1, { role: "assistant", activeUntil: T0 + 60 * MIN }),
      turn(a, "q2", "r1", 61),
    ];
    expect(buildDayLayout(turns, [a]).breaks).toEqual([]);
    // Without the run recorded, the same messages would read as an hour's pause.
    const bare = turns.map(({ activeUntil: _, ...t }) => t);
    expect(buildDayLayout(bare, [a]).breaks).toHaveLength(1);
  });

  it("puts a second branch of one chat on its own track", () => {
    const a = chat("A");
    const l = buildDayLayout(
      [
        turn(a, "q1", null, 0),
        turn(a, "a1", "q1", 1),
        turn(a, "a1b", "a1", 2),
        // A rewind: another reply to q1, after the first branch went on.
        turn(a, "q1-retry", "q1", 3, { role: "assistant" }),
      ],
      [a],
    );
    expect(dot(l, "a1b").track).toBe(0);
    expect(dot(l, "q1-retry").track).toBe(1);
    expect(l.lanes[0].tracks).toBe(2);
    expect(dot(l, "q1-retry").y - dot(l, "a1b").y).toBe(TRACK_H);
    expect(edgeInto(l, "q1-retry")).toMatchObject({ kind: "edge", cross: false });
  });

  it("gives a fork its own lane under its family, joined to the turn it forked at", () => {
    const root = chat("R", { title: "Root" });
    const fork = chat("F", { familyId: "R", parentSessionId: "R", title: "Root (fork)", familyTitle: "Root" });
    const other = chat("O");
    const l = buildDayLayout(
      [
        turn(other, "o1", null, -5),
        turn(root, "r1", null, 0),
        turn(root, "r2", "r1", 1),
        turn(fork, "f1", "r2", 4, { branchKind: "fork" }),
        turn(root, "r3", "r2", 6),
      ],
      [fork, other, root],
    );
    // Families by first turn; the root's lane first within its family.
    expect(l.lanes.map((x) => x.chat.sessionId)).toEqual(["O", "R", "F"]);
    expect(l.lanes.map((x) => x.familyStart)).toEqual([true, true, false]);
    const e = edgeInto(l, "f1");
    expect(e).toMatchObject({ kind: "edge", cross: true });
    expect(e.kind === "edge" && e.from.turn.id).toBe("r2");
    expect(dot(l, "r3").track).toBe(0);
  });

  it("dashes a prompt edit within one chat, and stubs a parent outside the day", () => {
    const a = chat("A");
    const l = buildDayLayout(
      [turn(a, "q1", "yesterday", 0), turn(a, "a1", "q1", 1), turn(a, "q1e", "yesterday", 2, { branchKind: "edit" })],
      [a],
    );
    expect(edgeInto(l, "q1")).toMatchObject({ kind: "lead", cross: false });
    expect(edgeInto(l, "q1e")).toMatchObject({ kind: "lead", cross: true });
    expect(dot(l, "q1e").track).toBe(1);
  });

  it("keeps turns with the same node id in different families apart", () => {
    const a = chat("A");
    const b = chat("B");
    const l = buildDayLayout([turn(a, "x", null, 0), turn(b, "x", null, 0), turn(b, "y", "x", 1)], [a, b]);
    expect(l.dots).toHaveLength(3);
    const e = edgeInto(l, "y");
    expect(e.kind === "edge" && e.from.lane).toBe(dot(l, "y").lane);
  });

  it("labels hours between turns, never inside a break", () => {
    const a = chat("A");
    const turns = [0, 10, 19, 28, 37, 46, 55, 64, 73, 200, 209].map((m, i) => turn(a, `t${i}`, i ? `t${i - 1}` : null, m));
    const l = buildDayLayout(turns, [a]);
    const xs = l.ticks.map((t) => t.x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    expect(l.ticks.some((t) => t.kind === "hour")).toBe(true);
    for (const t of l.ticks) for (const b of l.breaks) expect(t.x > b.x0 && t.x < b.x1).toBe(false);
  });

  it("keeps fixed-size time labels apart at any zoom, a resume over an hour", () => {
    const a = chat("A");
    const turns = [0, 10, 19, 28, 37, 46, 55, 64, 73, 200, 209].map((m, i) => turn(a, `t${i}`, i ? `t${i - 1}` : null, m));
    const l = buildDayLayout(turns, [a]);
    for (const k of [0.1, 0.3, 0.6, 1, 2]) {
      const shown = visibleTicks(l.ticks, k);
      for (let i = 1; i < shown.length; i++) expect((shown[i].x - shown[i - 1].x) * k).toBeGreaterThanOrEqual(64);
      expect(shown[0].kind).toBe("start");
    }
    // Zoomed in, every label fits; zoomed out, the resume after the break outlasts the hours near it.
    expect(visibleTicks(l.ticks, 4)).toHaveLength(l.ticks.length);
    expect(visibleTicks(l.ticks, 0.3).map((t) => t.kind)).toContain("resume");
  });

  it("walks within a chat and across chats", () => {
    const a = chat("A");
    const b = chat("B");
    const l = buildDayLayout(
      [turn(a, "a1", null, 0), turn(b, "b1", null, 1), turn(a, "a2", "a1", 5), turn(b, "b2", "b1", 9)],
      [a, b],
    );
    const key = (id: string) => dot(l, id).key;
    expect(stepInLane(l, key("a1"), 1)).toBe(key("a2"));
    expect(stepInLane(l, key("a2"), 1)).toBeNull();
    expect(stepInLane(l, key("a1"), -1)).toBeNull();
    expect(stepLane(l, key("a2"), 1)).toBe(key("b1")); // 4 min away, b2 is 4 too: the earlier wins
    expect(stepLane(l, key("b2"), -1)).toBe(key("a2"));
    expect(stepLane(l, key("a1"), -1)).toBeNull();
    expect(laneLatest(l, l.lanes[1])?.key).toBe(key("b2"));
  });

  it("lands a chat on its latest-ENDING turn, as the tree ranks its tip", () => {
    // test/endpoints.test.ts's branch: answer A runs 10:01–10:03, answer B starts and ends at 10:02.
    const a = chat("A");
    const l = buildDayLayout(
      [
        turn(a, "q", null, 0),
        turn(a, "ansA", "q", 1, { role: "assistant", endedAt: T0 + 3 * MIN }),
        turn(a, "ansB", "q", 2, { role: "assistant" }),
      ],
      [a],
    );
    expect(laneLatest(l, l.lanes[0])?.turn.id).toBe("ansA");
    // ←/→ still walk in start order.
    expect(stepInLane(l, dot(l, "ansA").key, 1)).toBe(dot(l, "ansB").key);
  });

  it("isn't idle while a turn from before the day is still running", () => {
    const a = chat("A");
    const b = chat("B");
    // A's reply ran 23:55–00:30 (yesterday's mark); B talks at 00:01 and 00:02; A's next prompt is at 00:31.
    const turns = [turn(b, "b1", null, 1), turn(b, "b2", "b1", 2), turn(a, "a2", "a1", 31)];
    expect(buildDayLayout(turns, [a, b]).breaks).toHaveLength(1);
    const running = [{ provider: "claude" as const, familyId: "A", sessionId: "A", start: T0 - 5 * MIN, end: T0 + 30 * MIN }];
    expect(buildDayLayout(turns, [a, b], running).breaks).toEqual([]);
  });

  it("makes a lane tall enough for its chat's whole name, wrapped", () => {
    const short = chat("S", { title: "Short" });
    const long = chat("L", { title: "Review the Agentree modernization round three findings and their resolution" });
    const word = chat("W", { title: "x".repeat(60) });
    expect(labelLines(short)).toBe(1);
    expect(labelLines(long)).toBeGreaterThan(2);
    expect(labelLines(word)).toBeGreaterThan(2);
    // A fork's name has less room (the ⑂ glyph), so it never wraps to fewer lines.
    expect(labelLines({ ...long, parentSessionId: "X" })).toBeGreaterThanOrEqual(labelLines(long));
    const l = buildDayLayout([turn(short, "s1", null, 0), turn(long, "l1", null, 1)], [short, long]);
    expect(l.lanes[0].height).toBe(2 * LANE_PAD + TRACK_H);
    expect(l.lanes[1].height).toBe(2 * LANE_PAD + labelLines(long) * LABEL_LINE_H);
    // The turn sits in the middle of the taller lane.
    expect(dot(l, "l1").y).toBe(l.lanes[1].top + l.lanes[1].height / 2);
    // With folders shown, a line more for each name.
    const dirs = buildDayLayout([turn(short, "s1", null, 0), turn(long, "l1", null, 1)], [short, long], [], { dirs: true });
    expect(dirs.lanes[0].height).toBe(2 * LANE_PAD + 2 * LABEL_LINE_H);
    expect(dirs.lanes[1].height).toBe(2 * LANE_PAD + (labelLines(long) + 1) * LABEL_LINE_H);
  });

  it("counts wide scripts and emoji as wide when wrapping a name", () => {
    // 80 CJK characters: a whole em each, broken between any two.
    const cjk = chat("C", { title: "日本語のタイトル".repeat(10) });
    const latin = chat("L", { title: "a".repeat(80) });
    expect(labelLines(cjk)).toBeGreaterThan(labelLines(latin));
    // 136px of room at 12px a character: 11 to a line.
    expect(labelLines(cjk)).toBe(Math.ceil(80 / 11));
    expect(labelLines(chat("E", { title: "🚀".repeat(12) }))).toBe(2);
  });

  it("shrinks dots as zoom closes turns up, so a track's turns never touch", () => {
    expect(dotRadius(1)).toBe(DOT_R);
    for (const k of [0.375, 0.4, 0.5, 0.75, 1, 2]) expect(MIN_GAP * k).toBeGreaterThanOrEqual(2 * dotRadius(k) + 2);
    expect(dotRadius(0.05)).toBe(2);
  });

  it("ignores turns whose chat isn't listed, and chats without turns", () => {
    const a = chat("A");
    const l = buildDayLayout([turn(a, "a1", null, 0), turn(chat("Z"), "z1", null, 1)], [a, chat("Empty")]);
    expect(l.lanes.map((x) => x.chat.sessionId)).toEqual(["A"]);
    expect(l.dots.map((d) => d.turn.id)).toEqual(["a1"]);
  });
});

describe("day layout fuzz", () => {
  /** Deterministic PRNG, so a failure reproduces. */
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
  }

  it("never overlaps two turns, and keeps time order across lanes", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const chats = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, i) =>
        chat(`S${i}`, {
          title: Array.from({ length: Math.floor(r() * 14) }, () => "word".repeat(1 + Math.floor(r() * 4))).join(" ") || `S${i}`,
          ...(i > 0 && r() < 0.3 ? { familyId: "S0", parentSessionId: "S0" } : {}),
        }),
      );
      const turns: DayTurn[] = [];
      let minute = 0;
      for (let i = 0; i < 1 + Math.floor(r() * 60); i++) {
        // Bursts (same minute), steady steps and long pauses.
        const p = r();
        minute += p < 0.3 ? 0 : p < 0.9 ? r() * 8 : 20 + r() * 200;
        const c = chats[Math.floor(r() * chats.length)];
        const mine = turns.filter((t) => t.sessionId === c.sessionId);
        const parent = mine.length && r() < 0.85 ? mine[Math.floor(r() * mine.length)].id : null;
        turns.push(turn(c, `t${i}`, parent, minute, { familyId: c.familyId }));
      }
      const l = buildDayLayout(turns, chats);
      expect(l.dots).toHaveLength(turns.length);
      for (let i = 1; i < l.dots.length; i++) {
        expect(l.dots[i].turn.timestamp).toBeGreaterThanOrEqual(l.dots[i - 1].turn.timestamp);
        expect(l.dots[i].x).toBeGreaterThanOrEqual(l.dots[i - 1].x);
      }
      for (let i = 0; i < l.dots.length; i++) {
        for (let j = i + 1; j < l.dots.length; j++) {
          const [p, q] = [l.dots[i], l.dots[j]];
          const apart = Math.abs(p.x - q.x) >= 2 * DOT_R + 2 || Math.abs(p.y - q.y) >= 2 * DOT_R + 2;
          if (!apart) throw new Error(`seed ${seed}: ${p.key} and ${q.key} overlap`);
        }
      }
      for (let i = 1; i < l.lanes.length; i++) {
        expect(l.lanes[i].top).toBeGreaterThanOrEqual(l.lanes[i - 1].top + l.lanes[i - 1].height);
      }
      for (const lane of l.lanes) expect(lane.height).toBeGreaterThanOrEqual(2 * LANE_PAD + labelLines(lane.chat) * LABEL_LINE_H);
      for (const d of l.dots) {
        const lane = l.lanes[d.lane];
        expect(d.y - DOT_R).toBeGreaterThanOrEqual(lane.top);
        expect(d.y + DOT_R).toBeLessThanOrEqual(lane.top + lane.height);
      }
    }
  });
});
