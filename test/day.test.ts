import { afterEach, describe, expect, it, vi } from "vitest";
import type { DayActivity } from "../shared/types.ts";

// Disposable homes before any provider is imported. Claude and Codex read the
// committed fixtures (read-only); Copilot reads one synthetic session written
// here, whose turns straddle midnight.
const COPILOT_ID = "c0c0c0c0-0000-4000-8000-000000000001";
vi.hoisted(() => {
  const p = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");
  const tmp = fs.mkdtempSync(p.join((require("node:os") as typeof import("node:os")).tmpdir(), "agentree-day-"));
  process.env.AGENTREE_HOME = p.join(tmp, "agentree");
  process.env.CLAUDE_CONFIG_DIR = p.join(__dirname, "fixtures", "claude", "2.1");
  process.env.CODEX_HOME = p.join(__dirname, "fixtures", "codex", "0.162", "home");
  process.env.COPILOT_HOME = p.join(tmp, "copilot");
  const id = "c0c0c0c0-0000-4000-8000-000000000001";
  const dir = p.join(tmp, "copilot", "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p.join(dir, "workspace.yaml"), `id: ${id}\ncwd: /work/late\nname: Late night\n`);
  const ev = (type: string, eid: string, ts: string, content?: string) =>
    JSON.stringify({ type, id: eid, timestamp: ts, data: content === undefined ? {} : { content } });
  fs.writeFileSync(
    p.join(dir, "events.jsonl"),
    [
      ev("session.start", "e0", "2026-10-01T22:00:00.000Z"),
      ev("user.message", "e1", "2026-10-01T23:59:30.000Z", "Before midnight"),
      ev("assistant.message", "e2", "2026-10-02T00:00:30.000Z", "After midnight"),
      ev("user.message", "e3", "2026-10-02T00:05:00.000Z", "And again"),
    ].join("\n") + "\n",
  );
});

// Spied on, to show which families a day loads, and that a disabled agent is never asked.
vi.mock("../electron/transcripts.ts", async (orig) => {
  const real = await orig<typeof import("../electron/transcripts.ts")>();
  return { ...real, listSessions: vi.fn(real.listSessions), loadSession: vi.fn(real.loadSession) };
});
vi.mock("../electron/providers/codex.ts", async (orig) => {
  const real = await orig<typeof import("../electron/providers/codex.ts")>();
  return { ...real, loadCodexSession: vi.fn(real.loadCodexSession) };
});

const { dayActivity, listAllSessions, loadAnySession } = await import("../electron/registry.ts");
const { writeSettings } = await import("../electron/settings.ts");
const claude = await import("../electron/transcripts.ts");
const codex = await import("../electron/providers/codex.ts");

const at = (iso: string) => Date.parse(iso);
const OCT1 = at("2026-10-01T00:00:00.000Z");
const DAY = 24 * 3_600_000;
const loads = () => vi.mocked(claude.loadSession).mock.calls.length + vi.mocked(codex.loadCodexSession).mock.calls.length;
const ids = (a: DayActivity, sessionId?: string) =>
  a.turns.filter((t) => !sessionId || t.sessionId === sessionId).map((t) => t.id);

afterEach(() => {
  writeSettings({ providers: { claude: true, codex: true, copilot: true } });
  vi.mocked(claude.loadSession).mockClear();
  vi.mocked(codex.loadCodexSession).mockClear();
  vi.mocked(claude.listSessions).mockClear();
});

describe("startedAt", () => {
  it("is known, and no later than any turn, for every family of every agent", () => {
    const list = listAllSessions();
    expect(new Set(list.map((m) => m.provider))).toEqual(new Set(["claude", "codex", "copilot"]));
    for (const m of list) {
      const nodes = loadAnySession(m.id)!.nodes;
      expect(m.startedAt, `${m.provider} ${m.id}`).toBeGreaterThan(0);
      for (const n of nodes) if (n.timestamp > 0) expect(n.timestamp, n.id).toBeGreaterThanOrEqual(m.startedAt!);
    }
    // The Copilot session began with a bookkeeping event, before its first turn.
    expect(list.find((m) => m.id === COPILOT_ID)?.startedAt).toBe(at("2026-10-01T22:00:00.000Z"));
  });
});

describe("dayActivity", () => {
  it("returns every turn of the day, each in the lane of the session that owns it", () => {
    const a = dayActivity(OCT1, OCT1 + DAY);
    const expected = listAllSessions().flatMap((m) =>
      loadAnySession(m.id)!
        .nodes.filter((n) => n.timestamp >= OCT1 && n.timestamp < OCT1 + DAY)
        .map((n) => `${m.provider}:${m.id}:${n.id}:${n.sourceSessionId ?? m.id}`),
    );
    expect(a.turns.map((t) => `${t.provider}:${t.familyId}:${t.id}:${t.sessionId}`).sort()).toEqual(expected.sort());
    // Oldest first, and a lane for every session with a turn — no more.
    const ts = a.turns.map((t) => t.timestamp);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
    expect(new Set(a.chats.map((c) => `${c.provider}:${c.sessionId}`))).toEqual(
      new Set(a.turns.map((t) => `${t.provider}:${t.sessionId}`)),
    );
  });

  it("draws a Claude fork in its own lane, starting from the turn it forked at", () => {
    const a = dayActivity(OCT1, OCT1 + DAY);
    const P = "11111111-1111-4111-8111-111111111111";
    const F = "22222222-2222-4222-8222-222222222222";
    expect(ids(a, P)).toEqual(["p-u1", "p-a1a", "p-u2", "p-a2", "p-u3", "p-a3", "p-u3b", "p-a3b"]);
    expect(ids(a, F)).toEqual(["f-u3", "f-a3"]);
    const fork = a.turns.find((t) => t.id === "f-u3")!;
    expect(fork).toMatchObject({ familyId: P, parentId: "p-a2", branchKind: "fork", role: "user", preview: "Try rollup instead" });
    expect(a.chats.find((c) => c.sessionId === F)).toMatchObject({
      familyId: P,
      parentSessionId: P,
      parentTitle: "Build walkthrough",
      title: "Build walkthrough (fork)",
      familyTitle: "Build walkthrough",
    });
    expect(a.chats.find((c) => c.sessionId === P)?.parentSessionId).toBeNull();
  });

  it("keeps the window half-open, by each turn's start", () => {
    const P = "11111111-1111-4111-8111-111111111111";
    const a = dayActivity(at("2026-10-01T10:02:00.000Z"), at("2026-10-01T10:05:00.000Z"));
    expect(ids(a, P)).toEqual(["p-u2", "p-a2", "p-u3"]);
  });

  it("splits a conversation at midnight, keeping the link to the turn before it", () => {
    const before = dayActivity(OCT1, OCT1 + DAY);
    const after = dayActivity(OCT1 + DAY, OCT1 + 2 * DAY);
    expect(ids(before, COPILOT_ID)).toEqual(["e1"]);
    expect(ids(after)).toEqual(["e2", "e3"]);
    // Its parent is yesterday's: the view draws a lead-in, not a dangling edge.
    expect(after.turns[0]).toMatchObject({ parentId: "e1", provider: "copilot", sessionId: COPILOT_ID });
    expect(after.chats).toEqual([
      expect.objectContaining({ provider: "copilot", sessionId: COPILOT_ID, title: "Late night", cwd: "/work/late" }),
    ]);
  });

  it("loads only the families whose records can reach the window, and reuses unchanged ones", () => {
    // Before every family started, and after every one was last touched: nothing to load.
    expect(dayActivity(OCT1 - DAY, OCT1).turns).toEqual([]);
    expect(dayActivity(OCT1 + 3 * DAY, OCT1 + 4 * DAY).turns).toEqual([]);
    expect(loads()).toBe(0);

    dayActivity(OCT1, OCT1 + DAY);
    const first = loads();
    expect(first).toBeGreaterThan(0);
    // A refresh with nothing written loads nothing again.
    dayActivity(OCT1, OCT1 + DAY);
    expect(loads()).toBe(first);
    // Another window is another projection.
    dayActivity(OCT1, OCT1 + DAY / 2);
    expect(loads()).toBe(2 * first);
  });

  it("never asks a disabled agent", () => {
    writeSettings({ providers: { claude: false } });
    vi.mocked(claude.listSessions).mockClear();
    const a = dayActivity(OCT1, OCT1 + DAY);
    expect(claude.listSessions).not.toHaveBeenCalled();
    expect(claude.loadSession).not.toHaveBeenCalled();
    expect(a.turns.length).toBeGreaterThan(0);
    expect(a.turns.every((t) => t.provider !== "claude")).toBe(true);
    expect(a.chats.every((c) => c.provider !== "claude")).toBe(true);
  });
});
