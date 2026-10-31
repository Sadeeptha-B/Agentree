import { describe, expect, it } from "vitest";
import { assignTips, childIndex, contextAt, copyHolders, endOf, heldTip, inferWindow, newestLeaf, pathToRoot, toNodeMap } from "../shared/render.ts";
import type { MemberInfo } from "../shared/types.ts";
import { mergeSameRoleRuns, parseRecords, type RawRecord } from "../electron/transcripts.ts";

/**
 * A node starts when its first part was written and ends with its last. Which
 * branch was active last — a session's tip, the leaf a focused member opens
 * on — is read from the end. One prompt, two answers: A, started first but
 * continued last, and B, written in between.
 */
const SID = "60000000-0000-4000-8000-000000000002";
const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();
const user = (uuid: string, parentUuid: string | null, min: number, text: string): RawRecord => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: at(min),
  promptId: "ep-1",
  message: { role: "user", content: text },
});
const asst = (uuid: string, parentUuid: string, min: number, id: string, text: string): RawRecord => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: at(min),
  message: { id, role: "assistant", content: [{ type: "text", text }] },
});

function tree(records: RawRecord[]) {
  const nodes = mergeSameRoleRuns(parseRecords(SID, { records, bad: 0 }).nodes);
  for (const n of nodes) n.heldBy = copyHolders(n);
  return nodes;
}
const pathOf = (nodes: ReturnType<typeof tree>, id: string | null) => pathToRoot(id, toNodeMap(nodes)).map((n) => n.text);

describe("a branch's last activity is its end, not its start", () => {
  it("across a same-role run", () => {
    const nodes = tree([
      user("u1", null, 0, "Pick one"),
      asst("a1", "u1", 1, "msg_a", "A begins."),
      asst("b1", "u1", 2, "msg_b", "B."),
      asst("a2", "a1", 3, "msg_a2", "A goes on."),
    ]);
    const a = nodes.find((n) => n.text.startsWith("A begins."))!;
    expect(a.text).toBe("A begins.\n\nA goes on.");
    expect(a.timestamp).toBe(Date.parse(at(1)));
    expect(newestLeaf(nodes, childIndex(nodes))).toBe(a.id);
    expect(pathOf(nodes, heldTip(nodes, (n) => !!n.heldBy?.includes(SID)))).toEqual(["Pick one", a.text]);
    const member: MemberInfo = { id: SID, title: "", parentId: null, cwd: "", resumeCommand: "", activeAt: 0, touchedAt: 0 };
    assignTips(nodes, [member]);
    expect(member.tipId).toBe(a.id);
  });

  it("across one reply streamed as several records", () => {
    const nodes = tree([
      user("u1", null, 0, "Pick one"),
      asst("a1", "u1", 1, "msg_a", "A begins. "),
      asst("b1", "u1", 2, "msg_b", "B."),
      asst("a1b", "a1", 3, "msg_a", "A ends."),
    ]);
    const a = nodes.find((n) => n.text.startsWith("A begins."))!;
    expect(a.endedAt).toBe(Date.parse(at(3)));
    expect(newestLeaf(nodes, childIndex(nodes))).toBe(a.id);
  });
});

describe("activity under a turn is not its end", () => {
  it("counts a reply's tool calls, results and tool-only replies for it, until the next drawn turn", () => {
    const tool = (uuid: string, parentUuid: string, min: number, id: string): RawRecord => ({
      type: "assistant",
      uuid,
      parentUuid,
      timestamp: at(min),
      message: { id, role: "assistant", content: [{ type: "tool_use", id: `tu_${uuid}`, name: "Bash", input: {} }] },
    });
    const result = (uuid: string, parentUuid: string, min: number): RawRecord => ({
      type: "user",
      uuid,
      parentUuid,
      timestamp: at(min),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${parentUuid}`, content: "ok" }] },
    });
    const nodes = tree([
      user("u1", null, 0, "Build it"),
      asst("a1", "u1", 1, "msg_a1", "Building."),
      tool("a1t", "a1", 1, "msg_a1"),
      result("r1", "a1t", 30),
      tool("t2", "r1", 31, "msg_t2"),
      result("r2", "t2", 45),
      user("u2", "r2", 46, "Thanks"),
    ]);
    const reply = nodes.find((n) => n.text === "Building.")!;
    // Drawn as one message; the work it set off ran until 10:45.
    expect(endOf(reply)).toBe(Date.parse(at(1)));
    expect(reply.activeUntil).toBe(Date.parse(at(45)));
    // The next prompt is a turn of its own: it neither ends the reply nor is kept busy.
    expect(nodes.find((n) => n.text === "Thanks")?.activeUntil).toBeUndefined();
    expect(nodes.find((n) => n.text === "Build it")?.activeUntil).toBeUndefined();
  });

  it("reads a queued message whose prompt is content blocks, as current CLIs write it", () => {
    const queued: RawRecord = {
      type: "attachment",
      uuid: "q1",
      parentUuid: "a1",
      timestamp: at(5),
      attachment: {
        type: "queued_command",
        prompt: [{ type: "text", text: "also back up first" }, { type: "image", source: { type: "base64", data: "AAAA" } }],
        commandMode: "prompt",
        origin: { kind: "human" },
      },
    };
    const nodes = tree([user("u1", null, 0, "Build it"), asst("a1", "u1", 1, "msg_a1", "Building."), queued]);
    expect(nodes.map((n) => [n.text, n.parentId])).toEqual([
      ["Build it", null],
      ["Building.", "u1"],
      ["also back up first", "a1"],
    ]);
  });

  it("keeps the reply before a block-prompt message from running on through it", () => {
    const queued: RawRecord = {
      type: "attachment",
      uuid: "q1",
      parentUuid: "a1",
      timestamp: at(5),
      attachment: { type: "queued_command", prompt: [{ type: "text", text: "also this" }], commandMode: "prompt", origin: { kind: "human" } },
    };
    const nodes = tree([
      user("u1", null, 0, "Build it"),
      asst("a1", "u1", 1, "msg_a1", "Building."),
      queued,
      asst("a2", "q1", 6, "msg_a2", "Built."),
    ]);
    const reply = nodes.find((n) => n.text === "Building.")!;
    expect(endOf(reply)).toBe(Date.parse(at(1)));
    expect(reply.activeUntil).toBeUndefined();
  });

  it("tells apart two answers to one call at one instant, though they are as long, and keeps a copy's", () => {
    const answer = (uuid: string, text: string): RawRecord => ({
      type: "user",
      uuid,
      parentUuid: "a1",
      timestamp: at(5),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: text }] },
    });
    const keyOf = (r: RawRecord) => {
      const { activity } = parseRecords("s", { records: [user("u1", null, 0, "Build it"), asst("a1", "u1", 1, "msg_a1", "Building."), r], bad: 0 });
      return activity.get("a1")![0].key;
    };
    expect(keyOf(answer("r1", "3 passed"))).not.toBe(keyOf(answer("r2", "1 failed")));
    // A copy's fresh uuid changes nothing.
    expect(keyOf(answer("r1", "3 passed"))).toBe(keyOf(answer("r3", "3 passed")));
  });

  it("divides an API message at anything drawn inside it, and only then", () => {
    const texts = (records: RawRecord[]) =>
      mergeSameRoleRuns(parseRecords("s", { records, bad: 0 }).nodes).map((n) => [n.text, n.parentId]);
    const start = [user("u1", null, 0, "Build it"), asst("a1", "u1", 1, "msg_a", "Part one.")];
    // A text prompt, as main has always read one.
    const queued: RawRecord = {
      type: "attachment",
      uuid: "q1",
      parentUuid: "a1",
      timestamp: at(2),
      attachment: { type: "queued_command", prompt: "also this", commandMode: "prompt", origin: { kind: "human" } },
    };
    expect(texts([...start, queued, asst("a2", "q1", 3, "msg_a", "Part two.")])).toEqual([
      ["Build it", null],
      ["Part one.", "u1"],
      ["also this", "a1"],
      ["Part two.", "q1"],
    ]);
    // Another reply between its records, in the chain.
    const aside = parseRecords("s", {
      records: [...start, asst("b1", "a1", 2, "msg_b", "Aside."), asst("a2", "b1", 3, "msg_a", "Part two.")],
      bad: 0,
    });
    expect(aside.nodes.map((n) => [n.text, n.parentId])).toEqual([
      ["Build it", null],
      ["Part one.", "u1"],
      ["Aside.", "a1"],
      ["Part two.", "b1"],
    ]);
    // A tool result between them draws nothing, so the message stays whole.
    const result: RawRecord = { ...user("r1", "a1", 2, ""), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } };
    expect(texts([...start, result, asst("a2", "r1", 3, "msg_a", "And more.")])).toEqual([
      ["Build it", null],
      ["Part one.\n\nAnd more.", "u1"],
    ]);
    // A drawn turn on another branch isn't inside it: only the chain counts.
    expect(texts([...start, user("u2", "u1", 2, "Elsewhere"), asst("a2", "a1", 3, "msg_a", "And more.")])).toEqual([
      ["Build it", null],
      ["Part one.\n\nAnd more.", "u1"],
      ["Elsewhere", "u1"],
    ]);
    // A block with none of its message above it continues what is above it.
    expect(texts([...start, user("u2", "u1", 2, "Elsewhere"), asst("a2", "u2", 3, "msg_a", "And more.")])).toEqual([
      ["Build it", null],
      ["Part one.", "u1"],
      ["Elsewhere", "u1"],
      ["And more.", "u2"],
    ]);
  });

  it("reads a block the CLI rewrote in place as that block, not a later part", () => {
    const again = { ...asst("a1", "u1", 1, "msg_a", "Part one, corrected.") };
    const parsed = parseRecords("s", {
      records: [user("u1", null, 0, "Build it"), asst("a1", "u1", 1, "msg_a", "Part one."), again],
      bad: 0,
    });
    expect(parsed.nodes.map((n) => n.id)).toEqual(["u1", "a1"]);
    expect(parsed.nodes[1].stableIds).toEqual(["m:msg_a"]);
  });

  it("draws a message's branches the same whichever was written first", () => {
    const draw = (order: string[]) => {
      const all: Record<string, RawRecord> = {
        u1: user("u1", null, 0, "Start"),
        a1: asst("a1", "u1", 1, "msg_m", "First."),
        q1: user("q1", "a1", 2, "Interrupt"),
        a2: asst("a2", "q1", 3, "msg_m", "After interruption."),
        a3: asst("a3", "a1", 4, "msg_m", "Sibling continuation."),
      };
      const nodes = parseRecords("s", { records: order.map((k) => all[k]), bad: 0 }).nodes;
      return nodes.map((n) => [n.text, n.parentId, n.lastRawId, n.stableIds![0]]).sort();
    };
    expect(draw(["u1", "a1", "a3", "q1", "a2"])).toEqual(draw(["u1", "a1", "q1", "a2", "a3"]));
  });

  it("keeps a tool call in its reply, past a block on another branch, unless that would strand the text", () => {
    const tool = (uuid: string, parentUuid: string, name: string): RawRecord => ({
      type: "assistant",
      uuid,
      parentUuid,
      timestamp: at(2),
      message: { id: "msg_a", role: "assistant", content: [{ type: "tool_use", id: uuid, name, input: {} }] },
    });
    const nodes = (records: RawRecord[]) => parseRecords("s", { records, bad: 0 }).nodes;
    const reply = asst("a1", "u1", 1, "msg_a", "Part one.");
    const prompt = user("u1", null, 0, "Build it");
    // Parallel calls, as written: the text stays on the chain of the last block.
    expect(nodes([prompt, reply, tool("t1", "a1", "Read"), tool("t2", "a1", "Grep")])[1]).toMatchObject({
      text: "Part one.",
      toolUses: ["Read", "Grep"],
      lastRawId: "t2",
    });
    // The text below the first call: a block off to the side can't end the node.
    const late = asst("a2", "t1", 3, "msg_a", "Part two.");
    const side = nodes([prompt, tool("t1", "u1", "Read"), late, tool("t2", "t1", "Grep")]);
    expect(side.map((n) => [n.text, n.lastRawId])).toEqual([
      ["Build it", "u1"],
      ["Part two.", "a2"],
    ]);
  });

  it("keeps a divided message's context apart from what it cost", () => {
    const usage = { input_tokens: 100_000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const billed = (uuid: string, parentUuid: string, min: number, id: string, text: string): RawRecord => {
      const r = asst(uuid, parentUuid, min, id, text);
      return { ...r, message: { ...r.message, usage } };
    };
    const parsed = parseRecords("s", {
      records: [
        user("u1", null, 0, "Build it"),
        billed("a1", "u1", 1, "msg_m", "First."),
        billed("b1", "a1", 2, "msg_b", "Aside."),
        billed("a2", "b1", 3, "msg_m", "Last."),
      ],
      bad: 0,
    });
    const nodes = mergeSameRoleRuns(parsed.nodes);
    const run = nodes.find((n) => n.role === "assistant")!;
    expect(run.text).toBe("First.\n\nAside.\n\nLast.");
    // Two API calls, so twice the cost; the context is one call's.
    expect(run.usage).toMatchObject({ input_tokens: 200_000, output_tokens: 20 });
    expect(contextAt(run.id, toNodeMap(nodes))).toBe(100_010);
    expect(inferWindow(nodes)).toBe(200_000);
  });

  it("reads a prompt of any shape without taking the provider down", () => {
    const queued = (uuid: string, parentUuid: string, prompt: unknown): RawRecord => ({
      type: "attachment",
      uuid,
      parentUuid,
      timestamp: at(5),
      attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" } } as RawRecord["attachment"],
    });
    const parsed = parseRecords("s", {
      records: [
        user("u1", null, 0, "Build it"),
        queued("q1", "u1", [null, "text", 7, { type: "text" }, { type: "text", text: "kept" }]),
        queued("q2", "q1", null),
        queued("q3", "q2", 42),
        queued("q4", "q3", [{ type: "video" }]),
        asst("a1", "q4", 6, "msg_a1", "Done."),
      ],
      bad: 0,
    });
    expect(parsed.nodes.map((n) => [n.text, n.parentId])).toEqual([
      ["Build it", null],
      ["kept", "u1"],
      ["Done.", "q1"],
    ]);
    expect(parsed.unreadMessages).toBe(3);
  });

  it("leaves a note that names an origin to be drawn, and never takes a title from one", () => {
    const meta = (uuid: string, parentUuid: string | null, min: number, text: string, origin?: RawRecord["origin"]): RawRecord => ({
      ...user(uuid, parentUuid, min, text),
      isMeta: true,
      origin,
    });
    const parsed = parseRecords("s", {
      records: [
        meta("n1", null, 0, "Continue from where you left off."),
        user("u1", "n1", 1, "Build it"),
        asst("a1", "u1", 2, "msg_a1", "Building."),
        meta("n2", "a1", 3, "A message from the team channel", { kind: "channel" }),
      ],
      bad: 0,
    });
    expect(parsed.nodes.map((n) => n.text)).toEqual(["Build it", "Building.", "A message from the team channel"]);
    expect(parsed.title).toBe("Build it");
  });

  it("doesn't call a file of nothing but notes unrecognized", () => {
    const record: RawRecord = { ...user("n1", null, 0, "Continue from where you left off."), isMeta: true };
    const parsed = parseRecords("s", { records: [record], bad: 0 });
    expect(parsed.nodes).toEqual([]);
    expect(parsed.problem).toBeUndefined();
  });

  it("draws a message once when the queue also holds its text", () => {
    const parsed = parseRecords("s", {
      records: [
        user("u1", null, 0, "Build it"),
        asst("a1", "u1", 1, "msg_a1", "Building."),
        { type: "queue-operation", operation: "enqueue", timestamp: at(2), content: "also   back up" },
        {
          type: "attachment",
          uuid: "q1",
          parentUuid: "a1",
          timestamp: at(3),
          attachment: {
            type: "queued_command",
            prompt: [{ type: "image", source: {} }, { type: "text", text: "also back up" }],
            commandMode: "prompt",
            origin: { kind: "human" },
          },
        },
        asst("a2", "q1", 4, "msg_a2", "Backed up."),
      ],
      bad: 0,
    });
    expect(parsed.nodes.map((n) => [n.text, !!n.injected])).toEqual([
      ["Build it", false],
      ["Building.", false],
      ["also back up", false],
      ["Backed up.", false],
    ]);
  });
});
