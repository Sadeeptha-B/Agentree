// Lives in src/ (not test/) so it type-checks with the renderer's DOM config.
import { describe, expect, it } from "vitest";
import type { DayActivity, DayChat, DayTurn, SessionMeta } from "../shared/types.ts";

// A zone with daylight saving, so the 23- and 25-hour days are real. Node
// re-reads TZ on assignment; each test file runs in its own process.
process.env.TZ = "America/New_York";
const { dayBounds, dayKeyOf, filterDay, isDayKey, latestActiveDay, resolveTarget, shiftDay } = await import("./day.ts");

const HOUR = 3_600_000;

describe("day keys and bounds", () => {
  it("is local midnight to the next local midnight", () => {
    const { start, end } = dayBounds("2026-10-28");
    expect(new Date(start).toString()).toMatch(/^Wed Oct 28 2026 00:00:00/);
    expect(end - start).toBe(24 * HOUR);
    expect(dayKeyOf(start)).toBe("2026-10-28");
    expect(dayKeyOf(end - 1)).toBe("2026-10-28");
    expect(dayKeyOf(end)).toBe("2026-10-29");
  });

  it("follows the calendar across clock changes", () => {
    const spring = dayBounds("2026-03-08");
    const fall = dayBounds("2026-11-01");
    expect(spring.end - spring.start).toBe(23 * HOUR);
    expect(fall.end - fall.start).toBe(25 * HOUR);
    expect(shiftDay("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDay("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftDay("2026-11-02", -1)).toBe("2026-11-01");
  });

  it("steps across months and years", () => {
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("accepts only real calendar days", () => {
    expect(isDayKey("2026-10-28")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-10-28T00:00")).toBe(false);
    expect(isDayKey("")).toBe(false);
  });

  it("knows the day of the newest activity", () => {
    const at = (activeAt: number) => ({ activeAt }) as SessionMeta;
    expect(latestActiveDay([])).toBeNull();
    expect(latestActiveDay([at(dayBounds("2026-10-20").start + HOUR), at(dayBounds("2026-10-26").end - 1)])).toBe(
      "2026-10-26",
    );
  });
});

describe("filterDay", () => {
  const chat = (provider: DayChat["provider"], sessionId: string, title: string, cwd: string, parent: string | null = null): DayChat => ({
    provider,
    familyId: parent ?? sessionId,
    sessionId,
    title,
    familyTitle: parent ? "Root chat" : title,
    cwd,
    parentSessionId: parent,
  });
  const turn = (c: DayChat, id: string): DayTurn => ({
    id,
    ref: { point: { nodeId: id, sessionId: c.sessionId, endId: id } },
    parentId: null,
    sessionId: c.sessionId,
    familyId: c.familyId,
    provider: c.provider,
    role: "user",
    preview: id,
    timestamp: 1,
  });
  const root = chat("claude", "aaaa1111", "Root chat", "/work/app");
  const fork = chat("claude", "bbbb2222", "Try the cache", "/work/other", "aaaa1111");
  const codex = chat("codex", "cccc3333", "Codex thing", "C:\\work\\app");
  const day: DayActivity = {
    start: 0,
    end: 1,
    chats: [root, fork, codex],
    running: [{ provider: "codex", familyId: "cccc3333", sessionId: "cccc3333", start: -1, end: 0 }],
    turns: [turn(root, "r1"), turn(fork, "f1"), turn(codex, "c1")],
  };
  const ids = (d: DayActivity) => d.turns.map((t) => t.id);
  const none = { query: "", cwd: "", provider: "" } as const;

  it("lets everything through without filters", () => {
    expect(filterDay(day, none)).toBe(day);
  });

  it("filters lanes by agent, by their own directory, and by search", () => {
    expect(ids(filterDay(day, { ...none, provider: "codex" }))).toEqual(["c1"]);
    // A turn still running from the day before goes with its chat.
    expect(filterDay(day, { ...none, provider: "codex" }).running).toHaveLength(1);
    expect(filterDay(day, { ...none, provider: "claude" }).running).toEqual([]);
    // The fork's own directory, not its family's.
    expect(ids(filterDay(day, { ...none, cwd: "/work/other" }))).toEqual(["f1"]);
    // cwdKey: one directory however it is spelled.
    expect(ids(filterDay(day, { ...none, cwd: "c:/work/app" }))).toEqual(["c1"]);
    expect(ids(filterDay(day, { ...none, query: "cache" }))).toEqual(["f1"]);
    // A family title finds its forks too; an id prefix finds the session.
    expect(ids(filterDay(day, { ...none, query: "root chat" }))).toEqual(["r1", "f1"]);
    expect(ids(filterDay(day, { ...none, query: "cccc" }))).toEqual(["c1"]);
    expect(filterDay(day, { ...none, query: "cache" }).chats).toEqual([fork]);
  });
});

describe("resolveTarget", () => {
  const turn = (id: string, sessionId: string, familyId: string, endId: string, at: number, endedAt?: number, provider: DayTurn["provider"] = "claude"): DayTurn => ({
    id,
    ref: { point: { nodeId: id, sessionId, endId }, stableIds: [`s:${id}`] },
    parentId: null,
    sessionId,
    familyId,
    provider,
    role: "assistant",
    preview: id,
    timestamp: at,
    ...(endedAt ? { endedAt } : {}),
  });
  const day: DayActivity = {
    start: 0,
    end: 100,
    chats: [],
    running: [],
    turns: [
      turn("p1", "P", "P", "p1", 10, 40),
      turn("p2", "P", "P", "p2", 20),
      turn("f1", "F", "P", "f1", 30),
      turn("x1", "X", "X", "x1", 50),
      turn("p1", "P", "P", "p1", 60, undefined, "codex"),
    ],
  };

  it("finds a tree's turn by where it was drawn to end, among that agent's turns", () => {
    // Drawn as one node ending on p2; the day draws p2 on its own.
    expect(resolveTarget(day, { provider: "claude", ref: { point: { nodeId: "p1", sessionId: "P", endId: "p2" } } })?.id).toBe("p2");
    expect(resolveTarget(day, { provider: "codex", ref: { point: { nodeId: "p1", sessionId: "P", endId: "p1" } } })?.timestamp).toBe(60);
    expect(resolveTarget(day, { provider: "claude", ref: { point: { nodeId: "gone", sessionId: "P", endId: "gone" } } })).toBeNull();
  });

  it("lands a conversation on the latest-ending turn of any of its sessions", () => {
    // p1 runs to 40, after f1 (30) and p2 (20) started.
    expect(resolveTarget(day, { provider: "claude", sessions: ["P", "F"] })?.id).toBe("p1");
    expect(resolveTarget(day, { provider: "claude", sessions: ["F"] })?.id).toBe("f1");
    expect(resolveTarget(day, { provider: "claude", sessions: ["nobody"] })).toBeNull();
  });
});
