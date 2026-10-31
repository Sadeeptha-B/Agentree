import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnNode } from "../shared/types.ts";

// A disposable Agentree home before meta.ts is imported.
vi.hoisted(() => {
  const p = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  process.env.AGENTREE_HOME = fs.mkdtempSync(p.join(os.tmpdir(), "agentree-annotations-"));
});

const { applyAnnotations, readMeta, writeAnnotation, writeMeta } = await import("../electron/meta.ts");
const { parseRecords } = await import("../electron/transcripts.ts");
const { digest, foldedDigest, qualify } = await import("../electron/identity.ts");

/**
 * Two prompts that share a prompt id (the CLI stamps one on every record of a
 * prompt, attachments included) and differ only in whitespace. Scheme 2's key
 * for the second is, character for character, scheme 3's key for the first.
 */
const SID = "60000000-0000-4000-8000-000000000001";
const rec = (uuid: string, parentUuid: string | null, type: "user" | "assistant", content: string, extra = {}) => ({
  type,
  uuid,
  parentUuid,
  sessionId: SID,
  timestamp: new Date(Date.UTC(2026, 9, 1, 10, Number(uuid.slice(-1)))).toISOString(),
  ...extra,
  message: { role: type, content: type === "user" ? content : [{ type: "text", text: content }], ...(type === "assistant" ? { id: `msg_${uuid}` } : {}) },
});
const records = [
  rec("u1", null, "user", "run tests", { promptId: "rt-1" }),
  rec("a2", "u1", "assistant", "Ran them."),
  rec("u3", "a2", "user", "run  tests", { promptId: "rt-1" }),
  rec("a4", "u3", "assistant", "Ran them again."),
];
let nodes: TurnNode[];
const fresh = () => parseRecords(SID, { records, bad: 0 }).nodes;
const shown = () => {
  const ns = fresh();
  applyAnnotations(ns, [SID]);
  return ns.filter((n) => n.role === "user").map((n) => n.label);
};
const prompt = (text: string) => nodes.find((n) => n.text === text)!;

beforeEach(() => {
  for (const k of Object.keys(readMeta(SID))) writeMeta(SID, k, { label: undefined, status: undefined, note: undefined });
  nodes = fresh();
});

/**
 * What is drawn decides a weak key's parent, so a change to what is drawn
 * moves it. A prompt with no prompt id stands under a message an earlier
 * parser skipped, and another under a note it drew.
 */
describe("a weak identity across a change to what is drawn", () => {
  const WID = "60000000-0000-4000-8000-000000000002";
  const block = (uuid: string, parentUuid: string, text: string) => ({
    type: "attachment",
    uuid,
    parentUuid,
    sessionId: WID,
    timestamp: new Date(Date.UTC(2026, 9, 1, 10, 5)).toISOString(),
    attachment: { type: "queued_command", prompt: [{ type: "text", text }], commandMode: "prompt", origin: { kind: "human" } },
  });
  const weak = (uuid: string, parentUuid: string | null, text: string, extra = {}) => ({
    ...rec(uuid, parentUuid, "user", text, extra),
    sessionId: WID,
  });
  const reply = (uuid: string, parentUuid: string, text: string, id: string) => ({
    ...rec(uuid, parentUuid, "assistant", text),
    sessionId: WID,
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  });
  const history = [
    weak("u1", null, "Start"),
    reply("a2", "u1", "Started.", "msg_w1"),
    block("q3", "a2", "also this"),
    weak("u4", "q3", "One more thing"),
    weak("n5", "u4", "Continue from where you left off.", { isMeta: true }),
    weak("u6", "n5", "And another"),
    reply("a7", "u6", "Done.", "msg_w2"),
  ];
  /** The same records as a parser before either change read them. */
  const earlier = history.map((r) => {
    if ("attachment" in r) return { ...r, attachment: { ...r.attachment, type: "skipped" } };
    const { isMeta: _, ...rest } = r as { isMeta?: boolean };
    return rest;
  });
  const parse = (records: object[]) => parseRecords(WID, { records: records as never[], bad: 0 }).nodes;
  const keyOf = (text: string) => parse(earlier).find((n) => n.text === text)!.stableIds![0];
  const clear = () => {
    for (const k of Object.keys(readMeta(WID))) writeMeta(WID, k, { label: undefined, status: undefined, note: undefined });
  };

  it("draws them as the change intends, under new parents", () => {
    const ns = parse(history);
    expect(ns.map((n) => [n.text, n.parentId])).toEqual([
      ["Start", null],
      ["Started.", "u1"],
      ["also this", "a2"],
      ["One more thing", "q3"],
      ["And another", "u4"],
      ["Done.", "u6"],
    ]);
    // Saved by a parser that qualified it by the reply, not the message.
    expect(keyOf("One more thing")).toBe(qualify(`u:|${digest("One more thing")}`, "m:msg_w1"));
    expect(ns.find((n) => n.text === "One more thing")!.stableIds![0]).not.toBe(keyOf("One more thing"));
  });

  it.each(["One more thing", "And another"])("still finds what was saved on %s", (text) => {
    clear();
    writeMeta(WID, keyOf(text), { label: "saved", status: "favorite", note: "why" });
    const ns = parse(history);
    applyAnnotations(ns, [WID]);
    expect(ns.find((n) => n.text === text)).toMatchObject({ label: "saved", status: "favorite", note: "why" });
    expect(ns.filter((n) => n.label)).toHaveLength(1);
  });

  it("clears it there too, so it can't come back", () => {
    clear();
    writeMeta(WID, keyOf("One more thing"), { label: "saved" });
    const ns = parse(history);
    applyAnnotations(ns, [WID]);
    writeAnnotation(ns.find((n) => n.text === "One more thing")!, ns, [WID], { label: undefined });
    const again = parse(history);
    applyAnnotations(again, [WID]);
    expect(again.some((n) => n.label)).toBe(false);
  });

  it("still finds what was saved below a reply a message now divides", () => {
    clear();
    const first = { ...reply("a2", "u1", "Starting.", "msg_w1") };
    const second = { ...reply("a4", "q3", "Done.", "msg_w1") };
    const divided = [weak("u1", null, "Start"), first, block("q3", "a2", "also this"), second, weak("u5", "a4", "Below it")];
    // Saved when the message was one node, below which this prompt stood.
    const saved = qualify(`u:|${digest("Below it")}`, "m:msg_w1");
    writeMeta(WID, saved, { label: "saved" });
    const ns = parse(divided);
    expect(ns.find((n) => n.text === "Below it")!.stableIds![0]).not.toBe(saved);
    applyAnnotations(ns, [WID]);
    expect(ns.find((n) => n.text === "Below it")!.label).toBe("saved");
  });

  it("gives a turn no earlier key where nothing it depends on changed", () => {
    const ns = parse(history);
    expect(ns.find((n) => n.text === "Start")!.legacyIds ?? []).not.toContain(keyOf("One more thing"));
    expect(ns.find((n) => n.text === "also this")!.legacyIds ?? []).toEqual([]);
    expect(ns.find((n) => n.text === "Done.")!.legacyIds ?? []).toEqual([]);
  });

  it("leaves the key to neither of two turns that both answer to it", () => {
    clear();
    // Two copies of a prompt, under two messages the earlier parser skipped.
    const twin = [
      weak("u1", null, "Start"),
      reply("a2", "u1", "Started.", "msg_w1"),
      block("q3", "a2", "first"),
      weak("u4", "q3", "Same words"),
      block("q5", "a2", "second"),
      weak("u6", "q5", "Same words"),
    ];
    const old = twin.map((r) => ("attachment" in r ? { ...r, attachment: { ...r.attachment, type: "skipped" } } : r));
    const saved = parse(old).find((n) => n.text === "Same words")!.stableIds![0];
    writeMeta(WID, saved, { label: "whose?" });
    const ns = parse(twin);
    applyAnnotations(ns, [WID]);
    expect(ns.some((n) => n.label)).toBe(false);
  });
});

describe("annotations on prompts that differ only in whitespace", () => {
  it("keep their own current keys: each can be set, changed and cleared alone", () => {
    expect(prompt("run tests").stableIds).not.toEqual(prompt("run  tests").stableIds);
    writeAnnotation(prompt("run tests"), nodes, [SID], { label: "A" });
    writeAnnotation(prompt("run  tests"), nodes, [SID], { label: "B" });
    expect(shown()).toEqual(["A", "B"]);
    writeAnnotation(prompt("run  tests"), nodes, [SID], { label: undefined });
    expect(shown()).toEqual(["A", undefined]);
  });

  it("leave an entry an earlier scheme gave both of them where it is, shown on neither", () => {
    // Scheme 2's key for both prompts; scheme 3's for the first alone.
    const shared = `u:rt-1|${foldedDigest("run tests")}`;
    writeMeta(SID, shared, { label: "old, whose?" });
    expect(shown()).toEqual([undefined, undefined]);
    // Writing to either prompt neither rewrites nor clears it.
    writeAnnotation(prompt("run tests"), nodes, [SID], { label: "new" });
    writeAnnotation(prompt("run  tests"), nodes, [SID], { label: undefined });
    expect(readMeta(SID)[shared]).toEqual({ label: "old, whose?" });
    expect(shown()).toEqual(["new", undefined]);
  });
});
