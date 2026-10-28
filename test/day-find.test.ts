import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DayActivity, DayTurn, DayWant } from "../shared/types.ts";

// The day view's selection and idle time against real projections (the
// layout's use of `activeUntil` and `running` is src/day-layout.test.ts), in a
// disposable home: Copilot sessions written here, and copies of the Claude
// endpoint fixtures (the quiet fork is added by a test).
const ROOT = vi.hoisted(() => {
  const p = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");
  const tmp = fs.mkdtempSync(p.join((require("node:os") as typeof import("node:os")).tmpdir(), "agentree-day-find-"));
  process.env.AGENTREE_HOME = p.join(tmp, "agentree");
  process.env.CLAUDE_CONFIG_DIR = p.join(tmp, "claude");
  process.env.CODEX_HOME = p.join(tmp, "codex");
  process.env.COPILOT_HOME = p.join(tmp, "copilot");
  fs.mkdirSync(p.join(tmp, "claude", "projects", "c--work-endpoint"), { recursive: true });
  fs.copyFileSync(
    p.join(__dirname, "fixtures", "claude", "2.1", "projects", "c--work-endpoint", "50000000-0000-4000-8000-00000000000b.jsonl"),
    p.join(tmp, "claude", "projects", "c--work-endpoint", "50000000-0000-4000-8000-00000000000b.jsonl"),
  );

  const session = (id: string, yaml: string, events: object[]) => {
    const dir = p.join(tmp, "copilot", "session-state", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p.join(dir, "workspace.yaml"), `id: ${id}\ncwd: /work/copilot\n${yaml}`);
    fs.writeFileSync(p.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };
  const ev = (type: string, id: string, ts: string, data: object = {}) => ({ type, id, timestamp: `2026-10-0${ts}Z`, data });
  const hello = (px: string, day: string) => [
    ev("user.message", `${px}1`, `${day}:00.000`, { content: "Hello" }),
    ev("assistant.message", `${px}2`, `${day}:30.000`, { content: "Hello there" }),
  ];
  // P, and F, its quiet fork: the same two events under rewritten ids.
  session("c1000000-0000-4000-8000-00000000000a", "name: Greeting\n", hello("p", "1T10:00"));
  session("c1000000-0000-4000-8000-00000000000b", "name: Greeting (fork)\nforked_from: c1000000-0000-4000-8000-00000000000a\n", hello("f", "1T10:00"));
  // X: an unrelated chat that opened the same way an hour earlier.
  session("c1000000-0000-4000-8000-00000000000c", "name: Other greeting\n", hello("x", "1T09:00"));
  // A reply whose tool runs for an hour, then the next prompt a minute later.
  session("c1000000-0000-4000-8000-00000000000d", "name: Build\n", [
    ev("user.message", "b1", "1T11:00:00.000", { content: "Run the build" }),
    ev("assistant.message", "b2", "1T11:01:00.000", { content: "Working", toolRequests: [{ name: "shell" }] }),
    ev("tool.execution_start", "b3", "1T11:01:01.000"),
    ev("tool.execution_complete", "b4", "1T12:00:00.000"),
    ev("assistant.turn_end", "b5", "1T12:00:01.000"),
    ev("user.message", "b6", "1T12:01:00.000", { content: "Thanks" }),
  ]);
  // The same past midnight, and another chat's turn while the tool still ran.
  session("c1000000-0000-4000-8000-00000000000e", "name: Night build\n", [
    ev("user.message", "n1", "1T23:50:00.000", { content: "Run the night build" }),
    ev("assistant.message", "n2", "1T23:51:00.000", { content: "Starting", toolRequests: [{ name: "shell" }] }),
    ev("tool.execution_complete", "n3", "2T00:40:00.000"),
    ev("assistant.turn_end", "n4", "2T00:40:01.000"),
    ev("user.message", "n5", "2T00:41:00.000", { content: "Next" }),
  ]);
  session("c1000000-0000-4000-8000-00000000000f", "name: Meanwhile\n", [
    ev("user.message", "m1", "2T00:05:00.000", { content: "Unrelated" }),
  ]);
  // A parent and its fork sharing a reply; only the fork went on working
  // under it, then the parent's next prompt. Once within a day (Oct 3), once
  // past midnight (Oct 3–4).
  const shared = (day: string, px: string, prompt: string, at: [string, string]) => [
    ev("user.message", `${px}1`, `${day}T${at[0]}`, { content: prompt }),
    ev("assistant.message", `${px}2`, `${day}T${at[1]}`, { content: "Working", toolRequests: [{ name: "shell" }] }),
  ];
  const forkOf = (parent: string) => `forked_from: ${parent}\n`;
  session("c2000000-0000-4000-8000-00000000000a", "name: Shared build\n", [
    ...shared("3", "g", "Build it", ["09:00:00.000", "09:01:00.000"]),
    ev("user.message", "g3", "3T10:01:00.000", { content: "Next" }),
  ]);
  session("c2000000-0000-4000-8000-00000000000b", `name: Shared build (fork)\n${forkOf("c2000000-0000-4000-8000-00000000000a")}`, [
    ...shared("3", "h", "Build it", ["09:00:00.000", "09:01:00.000"]),
    ev("tool.execution_complete", "h3", "3T10:00:00.000"),
    ev("assistant.turn_end", "h4", "3T10:00:01.000"),
  ]);
  session("c2000000-0000-4000-8000-00000000000c", "name: Night shared\n", [
    ...shared("3", "k", "Night build", ["23:50:00.000", "23:51:00.000"]),
    ev("user.message", "k3", "4T00:41:00.000", { content: "Next" }),
  ]);
  session("c2000000-0000-4000-8000-00000000000d", `name: Night shared (fork)\n${forkOf("c2000000-0000-4000-8000-00000000000c")}`, [
    ...shared("3", "j", "Night build", ["23:50:00.000", "23:51:00.000"]),
    ev("tool.execution_complete", "j3", "4T00:40:00.000"),
    ev("assistant.turn_end", "j4", "4T00:40:01.000"),
  ]);

  // Claude: a parent answered on Oct 1, and a fork of it made on Oct 3 at
  // noon (the copied reply re-stamped then, as forks do), whose own tool
  // result follows at 12:02. Another chat pauses that morning.
  const claudeDir = p.join(tmp, "claude", "projects", "c--work-late");
  fs.mkdirSync(claudeDir, { recursive: true });
  const [CP, CF, CO] = ["d0000000-0000-4000-8000-00000000000a", "d0000000-0000-4000-8000-00000000000b", "d0000000-0000-4000-8000-00000000000c"];
  const prompt = (sid: string, uuid: string, parentUuid: string | null, ts: string, text: string, extra = {}) => ({
    type: "user", uuid, parentUuid, sessionId: sid, timestamp: ts, cwd: "/work/late", promptId: `pr-${text}`,
    message: { role: "user", content: text }, ...extra,
  });
  const reply = (sid: string, uuid: string, parentUuid: string, ts: string, id: string, text: string, extra = {}) => ({
    type: "assistant", uuid, parentUuid, sessionId: sid, timestamp: ts, cwd: "/work/late",
    message: { id, role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: `tu_${id}`, name: "Bash", input: {} }] }, ...extra,
  });
  const jsonl = (recs: object[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(p.join(claudeDir, `${CP}.jsonl`), jsonl([
    prompt(CP, "cp-u1", null, "2026-10-01T09:00:00.000Z", "Check the build"),
    reply(CP, "cp-a1", "cp-u1", "2026-10-01T09:01:00.000Z", "msg_late1", "Checking."),
  ]));
  const forkedFrom = { forkedFrom: { sessionId: CP, messageUuid: "cp-a1" } };
  fs.writeFileSync(p.join(claudeDir, `${CF}.jsonl`), jsonl([
    prompt(CF, "cf-u1", null, "2026-10-01T09:00:00.000Z", "Check the build", forkedFrom),
    reply(CF, "cf-a1", "cf-u1", "2026-10-03T12:00:00.000Z", "msg_late1", "Checking.", forkedFrom),
    { type: "user", uuid: "cf-r1", parentUuid: "cf-a1", sessionId: CF, timestamp: "2026-10-03T12:02:00.000Z", cwd: "/work/late",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_msg_late1", content: "ok" }] } },
  ]));
  fs.writeFileSync(p.join(claudeDir, `${CO}.jsonl`), jsonl([
    prompt(CO, "co-u1", null, "2026-10-03T09:00:00.000Z", "Morning"),
    reply(CO, "co-a1", "co-u1", "2026-10-03T09:01:00.000Z", "msg_morning", "Morning."),
    prompt(CO, "co-u2", "co-a1", "2026-10-03T10:00:00.000Z", "Back"),
  ]));

  // Copilot: a reply whose tool run and turn end are recorded after it, to
  // fork with Agentree's own writer (the copy keeps those closing events).
  session("c3000000-0000-4000-8000-00000000000a", "name: To fork\n", [
    ev("user.message", "q1", "5T09:00:00.000", { content: "Run it" }),
    ev("assistant.message", "q2", "5T09:01:00.000", { content: "Running", toolRequests: [{ name: "shell" }] }),
    ev("tool.execution_complete", "q3", "5T10:00:00.000"),
    ev("assistant.turn_end", "q4", "5T10:00:01.000"),
  ]);

  // A Codex turn whose command runs for 48 minutes after the reply, then the next turn.
  const thread = "01900000-0000-7000-8000-0000000c0001";
  const turnA = "01900000-0000-7000-8000-0000000c00a1";
  const turnB = "01900000-0000-7000-8000-0000000c00b1";
  let ordinal = 1;
  const rec = (hm: string, payload: object, type = "event_msg") => ({
    timestamp: `2026-10-01T${hm}:00.000Z`,
    ordinal: ordinal++,
    type,
    payload,
  });
  const item = (hm: string, kind: "item_started" | "item_completed", turn_id: string, item: object) =>
    rec(hm, { type: kind, thread_id: thread, turn_id, item });
  const dir = p.join(tmp, "codex", "sessions", "2026", "10", "01");
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id: thread, cwd: "/work/codex", cli_version: "0.162.1", source: "vscode", thread_source: "user", history_mode: "paginated" };
  fs.writeFileSync(
    p.join(dir, `rollout-2026-10-01T13-00-00-${thread}.jsonl`),
    [
      { timestamp: "2026-10-01T13:00:00.000Z", type: "session_meta", payload: meta },
      rec("13:00", { type: "task_started", turn_id: turnA }),
      item("13:00", "item_completed", turnA, { type: "UserMessage", id: "item-1", content: [{ type: "text", text: "Migrate it" }] }),
      item("13:01", "item_completed", turnA, { type: "AgentMessage", id: "item-2", content: [{ type: "Text", text: "Migrating" }] }),
      item("13:02", "item_started", turnA, { type: "CommandExecution", id: "exec-1", command: ["migrate"] }),
      item("13:50", "item_completed", turnA, { type: "CommandExecution", id: "exec-1", command: ["migrate"], status: "completed" }),
      rec("13:50", { type: "task_complete", turn_id: turnA }),
      rec("13:51", { type: "task_started", turn_id: turnB }),
      item("13:51", "item_completed", turnB, { type: "UserMessage", id: "item-1", content: [{ type: "text", text: "Done?" }] }),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  return tmp;
});

const { dayActivity, forkAnyAt, loadAnySession } = await import("../electron/registry.ts");
const { forkPointOf } = await import("../shared/render.ts");

const at = (iso: string) => Date.parse(iso);
const OCT1 = at("2026-10-01T00:00:00.000Z");
const DAY = 24 * 3_600_000;
const [P, F, X, BUILD, NIGHT, MEANWHILE] = ["a", "b", "c", "d", "e", "f"].map((c) => `c1000000-0000-4000-8000-00000000000${c}`);
const EP = "50000000-0000-4000-8000-00000000000b";
const EF = "50000000-0000-4000-8000-00000000000c";

/** What the renderer asks for to carry a selected turn (`wantOf`). */
const wantOf = (t: DayTurn): DayWant => ({
  provider: t.provider,
  sessions: [...new Set([t.sessionId, ...(t.heldBy ?? []), t.familyId])],
  ref: t.ref,
});
const turn = (a: DayActivity, sessionId: string, preview: string) =>
  a.turns.find((t) => t.sessionId === sessionId && t.preview === preview)!;

describe("a day turn's selection, found again in its family", () => {
  it("follows a re-rooted family to the fork holding the turn, never to an unrelated chat with the same text", () => {
    const before = dayActivity(OCT1, OCT1 + DAY);
    const reply = turn(before, P, "Hello there");
    // Drawn once, in P's lane; F holds it too.
    expect(reply).toMatchObject({ familyId: P, heldBy: [F] });
    // X's reply has the same text identity: only family context tells them apart.
    expect(turn(before, X, "Hello there").ref.stableIds).toEqual(reply.ref.stableIds);

    fs.rmSync(path.join(ROOT, "copilot", "session-state", P), { recursive: true });
    const after = dayActivity(OCT1, OCT1 + DAY, wantOf(reply));
    expect(after.found).toMatchObject({ familyId: F, id: "f2" });
    expect(turn(after, F, "Hello there").id).toBe("f2");
  });

  it("is gone when no session that held it is left", () => {
    const x = turn(dayActivity(OCT1, OCT1 + DAY), X, "Hello there");
    const want: DayWant = { ...wantOf(x), sessions: ["nobody"], ref: { ...x.ref, point: { ...x.ref.point, sessionId: "nobody" } } };
    expect(dayActivity(OCT1, OCT1 + DAY, want).found).toBeNull();
  });

  it("finds a selected end that a split moved onto the next day, rather than its shorter head", () => {
    // ep-a1 "First prose." (10:01) and ep-a2 "Later prose." (10:03) are one
    // node while EP stands alone. A window ending between them stands for
    // midnight: the node starts in it, its end after it.
    const end = at("2026-10-01T10:02:00.000Z");
    const merged = dayActivity(OCT1, end).turns.find((t) => t.id === "ep-a1")!;
    expect(merged.ref.point).toMatchObject({ sessionId: EP, endId: "ep-a2" });

    // The quiet fork after "First prose." splits it.
    fs.copyFileSync(
      path.join(__dirname, "fixtures", "claude", "2.1", "projects", "c--work-endpoint", `${EF}.jsonl`),
      path.join(ROOT, "claude", "projects", "c--work-endpoint", `${EF}.jsonl`),
    );
    const after = dayActivity(OCT1, end, wantOf(merged));
    // The day's own turn under that head is now the shorter range…
    expect(after.turns.find((t) => t.id === "ep-a1")?.ref.point.endId).toBe("ep-a1");
    // …but the selection is where it ended: on another day, so not this one's.
    expect(after.found).toMatchObject({ familyId: EP, id: "ep-a2", timestamp: at("2026-10-01T10:03:00.000Z") });
    expect(after.found!.timestamp).toBeGreaterThanOrEqual(end);
    // The fork re-stamped its last copied record (10:20): that is its copy's
    // own end, not work done under the turn.
    expect(after.running.filter((r) => r.sessionId === EF)).toEqual([]);
  });

  it("finds a conversation's latest-ending turn, wherever it starts", () => {
    const a = dayActivity(OCT1 + DAY, OCT1 + 2 * DAY, { provider: "copilot", sessions: [BUILD] });
    expect(a.found).toMatchObject({ familyId: BUILD, id: "b6" });
    expect(a.turns.some((t) => t.sessionId === BUILD)).toBe(false);
  });
});

describe("idle time from recorded activity", () => {
  it("keeps a reply busy through its tool run, until a minute before the next prompt", () => {
    const a = dayActivity(OCT1, OCT1 + DAY);
    const working = turn(a, BUILD, "Working");
    expect(working).toMatchObject({ timestamp: at("2026-10-01T11:01:00.000Z"), activeUntil: at("2026-10-01T12:00:01.000Z") });
    // Display and "latest" are untouched: the reply is one message.
    expect(working.endedAt).toBeUndefined();
    // The next prompt is its own turn, not the reply's activity.
    expect(turn(a, BUILD, "Thanks").activeUntil).toBeUndefined();
  });

  it("keeps a Codex reply busy through the commands after it, within its turn", () => {
    const a = dayActivity(OCT1, OCT1 + DAY);
    const codex = a.turns.filter((t) => t.provider === "codex");
    expect(codex.map((t) => [t.preview, t.activeUntil])).toEqual([
      ["Migrate it", undefined],
      ["Migrating", at("2026-10-01T13:50:00.000Z")],
      ["Done?", undefined],
    ]);
  });

  it("keeps work a fork recorded under a shared reply, in the fork's lane", () => {
    const [G, H] = ["a", "b"].map((c) => `c2000000-0000-4000-8000-00000000000${c}`);
    const OCT3 = OCT1 + 2 * DAY;
    const a = dayActivity(OCT3, OCT3 + DAY);
    // Drawn once, in the parent's lane, which recorded nothing after it.
    const working = turn(a, G, "Working");
    expect(working).toMatchObject({ heldBy: [H] });
    expect(working.activeUntil).toBeUndefined();
    // The fork's work under it survives, as the fork's: its lane is listed, so the filters apply to it.
    // From its first record of it: the fork's work, not the shared reply, started then.
    expect(a.running.filter((r) => r.familyId === G)).toEqual([
      { provider: "copilot", familyId: G, sessionId: H, start: at("2026-10-03T10:00:00.000Z"), end: at("2026-10-03T10:00:01.000Z") },
    ]);
    expect(a.chats.some((c) => c.sessionId === H)).toBe(true);
  });

  it("counts a fork's work after midnight on that day, not from the shared reply the evening before", () => {
    const [K, J] = ["c", "d"].map((c) => `c2000000-0000-4000-8000-00000000000${c}`);
    const OCT3 = OCT1 + 2 * DAY;
    const OCT4 = OCT1 + 3 * DAY;
    const next = dayActivity(OCT4, OCT4 + DAY);
    expect(next.running.filter((r) => r.familyId === K)).toEqual([
      { provider: "copilot", familyId: K, sessionId: J, start: at("2026-10-04T00:40:00.000Z"), end: at("2026-10-04T00:40:01.000Z") },
    ]);
    expect(next.turns.filter((t) => t.familyId === K).map((t) => t.id)).toEqual(["k3"]);
    expect(dayActivity(OCT3, OCT3 + DAY).running.filter((r) => r.familyId === K)).toEqual([]);
  });

  it("starts a later copy's work when it did, so it can't cover an earlier pause", () => {
    const [CP, CF] = ["a", "b"].map((c) => `d0000000-0000-4000-8000-00000000000${c}`);
    const OCT3 = OCT1 + 2 * DAY;
    // The copied reply is drawn on Oct 1, in the parent's lane, held by the fork.
    const first = dayActivity(OCT1, OCT1 + DAY);
    expect(turn(first, CP, "Checking.")).toMatchObject({ familyId: CP, heldBy: [CF] });
    // Neither Oct 1 nor the morning of Oct 3 is the fork's work: it is from 12:02, its own tool result.
    expect(first.running.filter((r) => r.sessionId === CF)).toEqual([]);
    expect(dayActivity(OCT3, OCT3 + DAY).running.filter((r) => r.sessionId === CF)).toEqual([
      { provider: "claude", familyId: CP, sessionId: CF, start: at("2026-10-03T12:02:00.000Z"), end: at("2026-10-03T12:02:00.000Z") },
    ]);
  });

  it("finds no work in a fresh fork whose copy ends with the parent's closing events", async () => {
    const Q = "c3000000-0000-4000-8000-00000000000a";
    const OCT5 = OCT1 + 4 * DAY;
    const reply = loadAnySession(Q)!.nodes.find((n) => n.text === "Running")!;
    expect(reply.activeUntil).toBe(at("2026-10-05T10:00:01.000Z"));
    // Agentree's own Copilot fork writer, into this disposable store: it copies through the turn end.
    const fork = await forkAnyAt(Q, forkPointOf(reply));
    expect(fork.ok).toBe(true);
    const a = dayActivity(OCT5, OCT5 + DAY);
    const drawn = turn(a, Q, "Running");
    expect(drawn.heldBy?.length).toBe(1);
    // Copied history, however late it ends, is no work of the fork's.
    expect(a.running.filter((r) => r.familyId === Q)).toEqual([]);
  });

  it("carries a tool run past midnight into the next day, as running", () => {
    const next = dayActivity(OCT1 + DAY, OCT1 + 2 * DAY);
    expect(next.running.filter((r) => r.sessionId === NIGHT)).toEqual([
      { provider: "copilot", familyId: NIGHT, sessionId: NIGHT, start: at("2026-10-01T23:51:00.000Z"), end: at("2026-10-02T00:40:01.000Z") },
    ]);
    // So with another chat at 00:05, the night build's prompt at 00:41 follows one idle minute, not 50.
    expect(turn(next, MEANWHILE, "Unrelated").timestamp).toBe(at("2026-10-02T00:05:00.000Z"));
  });
});
