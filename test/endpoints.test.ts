import { describe, expect, it } from "vitest";
import { assignTips, childIndex, copyHolders, endOf, heldTip, newestLeaf, pathToRoot, toNodeMap } from "../shared/render.ts";
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
    expect(nodes.map((n) => n.text)).toEqual(expect.arrayContaining(["Build it", "Building."]));
  });
});
