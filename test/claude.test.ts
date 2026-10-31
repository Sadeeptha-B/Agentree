import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { actionTarget, childIndex, cwdKey, FORK_POINT_GONE, forkPointOf, pathToRoot, toNodeMap } from "../shared/render.ts";
import type { SessionDetail, TurnNode } from "../shared/types.ts";
import { claudeHealth, claudeWatchDirs, listSessions, loadSession, mergeSameRoleRuns, parseFile, parseRecords, readRecords } from "../electron/transcripts.ts";
import { forkClaudeAt } from "../electron/providers/claude-fork.ts";
import { readLineage } from "../electron/lineage.ts";
import { annotate } from "../electron/registry.ts";
import { readMeta, writeMeta } from "../electron/meta.ts";
import { digest, foldedDigest, qualify } from "../electron/identity.ts";

const P = "11111111-1111-4111-8111-111111111111";
const F = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const P1 = "41111111-1111-4111-8111-111111111111";
const F1 = "42222222-2222-4222-8222-222222222222";
const G1 = "43333333-3333-4333-8333-333333333333";
const P2 = "44444444-4444-4444-8444-444444444444";
const F2 = "45555555-5555-4555-8555-555555555555";
const QP = "46666666-6666-4666-8666-666666666666";
const QF = "47777777-7777-4777-8777-777777777777";
const KP = "48888888-8888-4888-8888-888888888888";
const KN = "49999999-9999-4999-8999-999999999999";
const NP = "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AT = "4ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PA = "4ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PB = "4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const P3 = "4fffffff-ffff-4fff-8fff-ffffffffffff";
const F3 = "50000000-0000-4000-8000-000000000001";
const G3 = "50000000-0000-4000-8000-000000000002";
const TL = "50000000-0000-4000-8000-000000000003";
const MV = "50000000-0000-4000-8000-000000000004";
const MO = "50000000-0000-4000-8000-000000000005";
const MF = "50000000-0000-4000-8000-000000000006";
const SP = "50000000-0000-4000-8000-000000000007";
const CD = "50000000-0000-4000-8000-000000000008";
const WP = "50000000-0000-4000-8000-000000000009";
const WF = "50000000-0000-4000-8000-00000000000a";
const EP = "50000000-0000-4000-8000-00000000000b";
const EF = "50000000-0000-4000-8000-00000000000c";
const UP = "50000000-0000-4000-8000-00000000000d";
const UF = "50000000-0000-4000-8000-00000000000e";
const GP = "50000000-0000-4000-8000-00000000000f";
const GF = "50000000-0000-4000-8000-000000000010";
const RNS = "50000000-0000-4000-8000-000000000011";
const DV = "50000000-0000-4000-8000-000000000012";
const SP4 = "50000000-0000-4000-8000-000000000013";
const SB4 = "50000000-0000-4000-8000-000000000014";
const SF4 = "50000000-0000-4000-8000-000000000015";
const BQ = "50000000-0000-4000-8000-000000000016";
const BN = "50000000-0000-4000-8000-000000000017";
const BE = "50000000-0000-4000-8000-000000000018";
const HP = "50000000-0000-4000-8000-000000000019";
const HF = "50000000-0000-4000-8000-00000000001a";
const HQ = "50000000-0000-4000-8000-00000000001b";
const BI = "50000000-0000-4000-8000-00000000001d";
const BJ = "50000000-0000-4000-8000-00000000001e";
const BK = "50000000-0000-4000-8000-000000000021";
const GUARD_OUT = "Change it:\n\n```python\nif ready:\n    send()\ncancel()\n```";
const GUARD_IN = "Change it:\n\n```python\nif ready:\n    send()\n    cancel()\n```";
const EP_PROMPT = "Summarise the log\n\n  - errors only";
let claudeRoot: string;
let projects: string;
const projectDir = (name = "c--work-demo") => path.join(projects, name);
const readJsonl = (file: string) =>
  fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Every tree Agentree hands the renderer must be one: unique ids, no dangling parents, no cycles. */
function expectTree(d: SessionDetail) {
  const ids = new Set(d.nodes.map((n) => n.id));
  expect(ids.size).toBe(d.nodes.length);
  for (const n of d.nodes) if (n.parentId) expect(ids.has(n.parentId)).toBe(true);
  const map = toNodeMap(d.nodes);
  for (const n of d.nodes) expect(pathToRoot(n.id, map)[0].parentId).toBeNull();
}
const byText = (d: SessionDetail, t: string) => d.nodes.filter((n) => n.text === t);
const one = (d: SessionDetail, t: string): TurnNode => {
  const hits = byText(d, t);
  expect(hits, `"${t}" drawn once`).toHaveLength(1);
  return hits[0];
};
const kidsOf = (d: SessionDetail, n: TurnNode) =>
  (childIndex(d.nodes).get(n.id) ?? []).map((k) => k.text).sort();

beforeAll(() => {
  // Work on a copy: the fork tests write new transcripts.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-claude-"));
  fs.cpSync(path.join(__dirname, "fixtures", "claude", "2.1"), path.join(tmp, "claude"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
  process.env.AGENTREE_HOME = path.join(tmp, "agentree");
  // The registry is used for annotations; keep the other harnesses off the real home dir.
  process.env.CODEX_HOME = path.join(tmp, "no-codex");
  process.env.COPILOT_HOME = path.join(tmp, "no-copilot");
  projects = path.join(tmp, "claude", "projects");
  claudeRoot = path.join(tmp, "claude");
});

describe("Claude transcripts", () => {
  it("lists one entry per fork family and never merges on an opening prompt alone", () => {
    const list = listSessions().filter((s) => [P, F, S].includes(s.id));
    expect(list.map((s) => s.id).sort()).toEqual([P, S]);
    expect(list.find((s) => s.id === P)!.members).toBe(2);
    expect(list.find((s) => s.id === S)!.members).toBe(1);
  });

  it("names a family's forks on its list entry, and gives each member its own tip", () => {
    expect(listSessions().find((s) => s.id === P)!.forks).toEqual([
      expect.objectContaining({ id: F, title: "Build walkthrough (fork)", cwd: "C:\\work\\demo" }),
    ]);
    const d = loadSession(P)!;
    const tip = (id: string) => d.nodes.find((n) => n.id === d.members.find((m) => m.id === id)!.tipId)?.text;
    expect(tip(F)).toBe("Switched to rollup.");
    // P's own newest leaf, not the family's (F's turns aren't P's).
    expect(tip(P)).toBe("Waiting.");
  });

  it("titles from ai-title, never the IDE wrapper", () => {
    const fam = listSessions().find((s) => s.id === P)!;
    expect(fam.title).toBe("Build walkthrough");
    expect(fam.entrypoint).toBe("claude-vscode");
    expect(listSessions().find((s) => s.id === S)!.title).toBe("Explain the build");
  });

  it("drops ide_* context from turn text and ignores api-request-blob records", () => {
    const d = loadSession(P)!;
    expect(d.nodes.find((n) => n.parentId === null)!.text).toBe("Explain the build");
    expect(d.nodes.some((n) => n.text.includes("NOT A TURN"))).toBe(false);
  });

  it("stitches the extension fork in at the turn it was taken after", () => {
    for (const id of [P, F]) {
      const d = loadSession(id)!;
      expectTree(d);
      expect(d.meta.id).toBe(P); // any member opens the family
      // Two rewind branches inside P, plus the fork's own first prompt.
      expect(kidsOf(d, one(d, "Added vitest."))).toEqual(["Actually, wait", "Ship it", "Try rollup instead"]);
      const forkTurn = one(d, "Try rollup instead");
      expect(forkTurn.branchKind).toBe("fork");
      expect(forkTurn.sourceSessionId).toBe(F);
      one(d, "Explain the build"); // the shared prefix exists once
      expect(d.meta.branchPoints).toBe(1);
      expect(d.members.find((m) => m.id === F)!.parentId).toBe(P);
    }
  });

  it("keeps the fork's parent when that parent rewinds after being forked from", () => {
    const d = loadSession(G1)!;
    expectTree(d);
    expect(d.meta.id).toBe(P1);
    const parents = Object.fromEntries(d.members.map((m) => [m.id, m.parentId]));
    expect(parents).toEqual({ [P1]: null, [F1]: P1, [G1]: F1 });
    // F1's own reply exists once, and G1 continues from it.
    expect(kidsOf(d, one(d, "Rollback is a revert."))).toEqual(["Script the revert"]);
    expect(one(d, "Script the revert").branchKind).toBe("fork");
    // F1's later rewind is its own branch off the first reply.
    expect(kidsOf(d, one(d, "Three steps."))).toEqual(["Detail step one", "Start over with a hotfix"]);
  });

  it("never lets title order contradict explicit lineage (no cycle, no duplicated prefix)", () => {
    const d = loadSession(F2)!;
    expectTree(d);
    expect(d.meta.id).toBe(P2);
    expect(Object.fromEntries(d.members.map((m) => [m.id, m.parentId]))).toEqual({ [P2]: null, [F2]: P2 });
    expect(kidsOf(d, one(d, "Dear team,"))).toEqual(["Make it formal", "Make it shorter"]);
  });

  it("joins a fork taken on a regenerated first answer", () => {
    const list = listSessions().filter((s) => [QP, QF].includes(s.id));
    expect(list).toHaveLength(1);
    expect(list[0].members).toBe(2);
    const d = loadSession(QF)!;
    expectTree(d);
    expect(kidsOf(d, one(d, "Name the project"))).toEqual(["Call it Atlas.", "Call it Beacon."]);
    expect(kidsOf(d, one(d, "It guides."))).toEqual(["Pick a logo"]);
  });

  it("aligns a native fork of a compacted session across the stale logical parent", () => {
    const d = loadSession(KN)!;
    expectTree(d);
    expect(d.members).toHaveLength(2);
    expect(d.nodes.filter((n) => n.parentId === null)).toHaveLength(1);
    expect(kidsOf(d, one(d, "Continuing with issue one."))).toEqual(["Fix issue three instead", "Fix issue two"]);
    // Pre-compact turns are drawn, and say why they can't be forked.
    expect(one(d, "Found four issues.").forkBlocked).toMatch(/compact/);
  });

  it("dates a session by its newest conversation record, not its newest bookkeeping", () => {
    const s = listSessions().find((x) => x.id === TL)!;
    // The tool loop ran until 10:09; the mode change at 15:00 is a file change only.
    expect(new Date(s.activeAt).toISOString()).toBe("2026-10-01T10:09:00.000Z");
    expect(new Date(s.touchedAt).toISOString()).toBe("2026-10-01T15:00:00.000Z");
  });

  it("files a session under the directory it continued in, not the first one", () => {
    const s = listSessions().find((x) => x.id === MV)!;
    expect(s.cwd).toBe("/c/work/new");
    expect(cwdKey(s.cwd)).toBe(cwdKey("C:/work/new"));
    expect(loadSession(MV)!.meta.cwd).toBe("/c/work/new");
    // No project folder to go by: a cd into a subfolder, or up past the
    // start, doesn't move the session.
    expect(listSessions().find((x) => x.id === CD)!.cwd).toBe("C:\\repo");
  });

  it("counts an unparseable transcript as failed, not hidden", () => {
    listSessions();
    const h = claudeHealth();
    expect(h.filesSeen).toBe(40);
    expect(h.failed).toBe(1);
    expect(h.sessionsParsed).toBe(38);
    // The moved session's old copy: every record is in the new one.
    expect(h.skipped).toBe(1);
    expect(h.warnings.join(" ")).toMatch(/couldn't be read/);
    expect(h.warnings.join(" ")).toMatch(/2 sessions have copies in more than one project folder.*1 of them diverged/);
    expect(h.unknownRecordTypes).toEqual({});
    // A message the user typed that became no turn is never silent.
    expect(h.warnings.join(" ")).toMatch(/1 message typed mid-turn couldn't be read/);
  });
});

describe("Claude sessions stored in several project folders", () => {
  it("lists a moved session once, as its newest copy, with a fork from a third folder", () => {
    const list = listSessions().filter((s) => [MO, MF].includes(s.id));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: MO, members: 2, cwd: "C:\\work\\articulation", title: "Package rename" });
    for (const id of [MO, MF]) {
      const d = loadSession(id)!;
      expectTree(d);
      expect(d.meta.id).toBe(MO);
      // The continuation that exists only in the new folder's copy is drawn.
      expect(kidsOf(d, one(d, "Imports updated."))).toEqual(["Publish it"]);
      expect(one(d, "Publish it")).toMatchObject({ branchKind: "fork", sourceSessionId: MF });
      expect(d.members.find((m) => m.id === MO)!.files).toHaveLength(2);
      expect(d.members.find((m) => m.id === MF)!.parentId).toBe(MO);
      expect(d.nodes.find((n) => n.id === d.members.find((m) => m.id === MF)!.tipId)?.text).toBe("Published.");
    }
    // The family is filed under the fork's folder too.
    expect(list[0].forks).toEqual([expect.objectContaining({ id: MF, cwd: "C:\\work\\third" })]);
    // The live view watches every folder the family lives in.
    expect(claudeWatchDirs(MF).map((d) => path.basename(d)).sort()).toEqual([
      "c--work-moved-a-old",
      "c--work-moved-b-new",
      "c--work-moved-c-third",
    ]);
  });

  it("draws both continuations of copies that diverged after a shared prefix", () => {
    expect(listSessions().filter((s) => s.id === SP)).toHaveLength(1);
    const d = loadSession(SP)!;
    expectTree(d);
    expect(d.nodes.filter((n) => n.parentId === null)).toHaveLength(1);
    expect(kidsOf(d, one(d, "Two phases."))).toEqual(["Phase one first", "Phase two first"]);
    one(d, "Phase one done.");
    one(d, "Phase two done.");
  });

  it("forks a moved session from the copy that holds the turn, next to it", () => {
    const d = loadSession(MO)!;
    const res = forkClaudeAt(MO, forkPointOf(one(d, "Imports updated.")));
    expect(res).toMatchObject({ ok: true, cwd: "C:\\work\\articulation" });
    if (!res.ok) return;
    expect(fs.existsSync(path.join(projectDir("c--work-moved-b-new"), `${res.id}.jsonl`))).toBe(true);
    const after = loadSession(MO)!;
    expectTree(after);
    expect(after.nodes.length).toBe(d.nodes.length);
    fs.rmSync(path.join(projectDir("c--work-moved-b-new"), `${res.id}.jsonl`));
  });
});

describe("Claude display merge and fork endpoints", () => {
  it("never folds a part that can't anchor into one that can, so grouping takes no cut away", () => {
    // Prompt, (tools-only reply, not drawn), mid-turn message: the prompt is a
    // cut, and folding the message in would refuse it.
    const d = loadSession(AT)!;
    expectTree(d);
    const prompt = one(d, "Run the migration");
    expect(prompt.forkBlocked).toBeUndefined();
    const message = one(d, "also back up first");
    expect(message.parentId).toBe(prompt.id);
    expect(message.midTurn).toBe(true);
    expect(forkClaudeAt(AT, forkPointOf(message))).toMatchObject({ ok: false });
    // The turn after it is the fork point, and it keeps the message.
    const reply = one(d, "Backed up, then migrated.");
    expect(reply.forkBlocked).toBeUndefined();
    const fork = forkClaudeAt(AT, forkPointOf(prompt));
    expect(fork.ok).toBe(true);
    if (!fork.ok) return;
    const file = path.join(projectDir("c--work-attach"), `${fork.id}.jsonl`);
    expect(readJsonl(file).some((r) => r.type === "attachment")).toBe(false);
    fs.rmSync(file);
  });

  it("keeps prompts distinct that share a long opening and lack a promptId", () => {
    const d = loadSession(PA)!;
    expectTree(d);
    const shared = one(d, "Two options.");
    const kids = (childIndex(d.nodes).get(shared.id) ?? []).map((n) => n.text);
    expect(kids.map((t) => t.slice(-10).trim()).sort()).toEqual(["use Redis", "use SQLite"]);
    const redis = d.nodes.find((n) => n.text.endsWith("use Redis"))!;
    expect(one(d, "Redis answer.").parentId).toBe(redis.id);
    expect(redis.branchKind).toBe("fork");
  });
});

describe("Claude prompt identity", () => {
  it("keeps prompts apart that differ only in indentation, each with its own reply", () => {
    const d = loadSession(WF)!;
    expectTree(d);
    expect(d.meta.id).toBe(WP);
    const out = one(d, GUARD_OUT);
    const inside = one(d, GUARD_IN);
    expect(kidsOf(d, one(d, "Here is the guard."))).toEqual([GUARD_OUT, GUARD_IN].sort());
    expect(one(d, "Unconditional cancel.").parentId).toBe(out.id);
    expect(one(d, "Conditional cancel.").parentId).toBe(inside.id);
    expect(inside).toMatchObject({ branchKind: "fork", sourceSessionId: WF });
    expect(out.stableIds).not.toEqual(inside.stableIds);
  });
});

describe("Claude mid-turn messages written as content blocks", () => {
  const session = () => {
    const d = loadSession(BQ)!;
    expectTree(d);
    return d;
  };
  const projectFile = (sid: string) => path.join(projectDir("c--work-blockq"), `${sid}.jsonl`);

  it("draws each one where it was delivered, in one line of history", () => {
    const d = session();
    const main = pathToRoot(one(d, "You're welcome.").id, toNodeMap(d.nodes));
    expect(main.map((n) => n.text)).toEqual([
      "Refactor the importer",
      "Reading the importer.",
      "keep the old parser too",
      "Kept both parsers.",
      "Now add tests",
      "match this screenshot",
      "Tests added.",
      "[image]\n\nand one more",
      "Done.",
      "Thanks",
      "You're welcome.",
    ]);
    // Nothing else is drawn but the fork's turns, and no message makes a branch.
    expect(kidsOf(d, one(d, "Reading the importer."))).toEqual(["keep the old parser too"]);
    expect(kidsOf(d, one(d, "keep the old parser too"))).toEqual(["Kept both parsers."]);
    expect(d.nodes.map((n) => n.text).sort()).toEqual(
      [...main.map((n) => n.text), "Actually, drop the old parser", "Dropped it."].sort(),
    );
  });

  it("marks only the message itself as mid-turn, and refuses only what can't anchor", () => {
    const d = session();
    const message = one(d, "keep the old parser too");
    expect(message).toMatchObject({ midTurn: true, role: "user" });
    expect(message.forkBlocked).toMatch(/mid-turn/);
    expect(message.injected).toBeUndefined();
    // Two messages in a row are one mid-turn node.
    expect(one(d, "[image]\n\nand one more")).toMatchObject({ midTurn: true });
    // A prompt keeps its cut: what follows it can't anchor, so it stays apart.
    expect(one(d, "Now add tests").forkBlocked).toBeUndefined();
    expect(one(d, "match this screenshot").midTurn).toBe(true);
    expect(one(d, "Reading the importer.").forkBlocked).toBeUndefined();
    expect(one(d, "Kept both parsers.").forkBlocked).toBeUndefined();
  });

  it("forks either side of a message, keeping it only after it", () => {
    const d = session();
    const before = forkClaudeAt(BQ, forkPointOf(one(d, "Reading the importer.")));
    const after = forkClaudeAt(BQ, forkPointOf(one(d, "Kept both parsers.")));
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    const queuedIn = (id: string) =>
      readJsonl(projectFile(id)).filter((r) => r.attachment?.type === "queued_command").length;
    expect(queuedIn(before.id)).toBe(0);
    expect(queuedIn(after.id)).toBe(1);
    const again = loadSession(BQ)!;
    expect(again.nodes.length).toBe(d.nodes.length);
    expect(one(again, "keep the old parser too").heldBy).toContain(after.id);
    expect(one(again, "keep the old parser too").heldBy).not.toContain(before.id);
    for (const r of [before, after]) fs.rmSync(projectFile(r.id));
  });

  it("stitches a copy of the message onto it, and ends a fork that stopped short before it", () => {
    const d = session();
    const reading = one(d, "Reading the importer.");
    const message = one(d, "keep the old parser too");
    const kept = one(d, "Kept both parsers.");
    expect(new Set(message.heldBy)).toEqual(new Set([BQ, BN]));
    expect(new Set(reading.heldBy)).toEqual(new Set([BQ, BN, BE]));
    expect(d.members.find((m) => m.id === BE)!.tipId).toBe(reading.id);
    // The fork's own turn branches where the fork was made, not at the message.
    expect(one(d, "Actually, drop the old parser")).toMatchObject({ parentId: kept.id, branchKind: "fork" });
    // Open and Resume stay with the focused member while it holds the turn.
    expect(actionTarget(d, reading, BE).ref.sessionId).toBe(BE);
    expect(actionTarget(d, message, BE).ref.sessionId).toBe(BQ);
    expect(actionTarget(d, message, BN).ref.sessionId).toBe(BN);
  });

  it("keeps every identity a turn had before the message was drawn", () => {
    const records = readRecords(projectFile(BQ))!;
    const drawn = (recs: typeof records) => parseRecords(BQ, { records: recs, bad: 0 }).nodes;
    // An earlier parser skipped these for display and followed their lineage.
    const unread = records.map((r) =>
      r.attachment?.type === "queued_command" && Array.isArray(r.attachment.prompt)
        ? { ...r, attachment: { ...r.attachment, type: "skipped" } }
        : r,
    );
    const earlier = drawn(unread);
    const now = new Map(drawn(records).map((n) => [n.id, n]));
    expect(now.size).toBe(earlier.length + 4);
    for (const n of earlier) expect(now.get(n.id)?.stableIds, n.text).toEqual(n.stableIds);
  });

  it("draws a message once when the queue holds it whole and the prompt splits it, through a fork", () => {
    const sid = "50000000-0000-4000-8000-00000000001c";
    const dir = projectDir("c--work-split-prompt");
    const file = path.join(dir, `${sid}.jsonl`);
    const base = { sessionId: sid, cwd: "C:\\work\\split", isSidechain: false };
    const at = (min: number) => new Date(Date.UTC(2026, 9, 2, 10, min)).toISOString();
    const records = [
      { ...base, type: "user", uuid: "s-u1", parentUuid: null, promptId: "s-1", timestamp: at(0), message: { role: "user", content: "Run the migration" } },
      { ...base, type: "assistant", uuid: "s-a1", parentUuid: "s-u1", timestamp: at(1), message: { id: "msg_s1", role: "assistant", content: [{ type: "text", text: "Migrating." }] } },
      { type: "queue-operation", operation: "enqueue", sessionId: sid, timestamp: at(2), content: "also back up" },
      {
        ...base, type: "attachment", uuid: "s-q1", parentUuid: "s-a1", timestamp: at(3),
        attachment: { type: "queued_command", prompt: [{ type: "text", text: "also " }, { type: "text", text: "back up" }], commandMode: "prompt", origin: { kind: "human" } },
      },
      { ...base, type: "assistant", uuid: "s-a2", parentUuid: "s-q1", timestamp: at(4), message: { id: "msg_s2", role: "assistant", content: [{ type: "text", text: "Backed up." }] } },
    ];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    try {
      const d = loadSession(sid)!;
      const texts = ["Run the migration", "Migrating.", "also back up", "Backed up."];
      expect(d.nodes.map((n) => n.text)).toEqual(texts);
      const fork = forkClaudeAt(sid, forkPointOf(one(d, "Backed up.")));
      expect(fork.ok).toBe(true);
      // The fork holds the attachment and no queue: the family must still read as one line.
      const again = loadSession(sid)!;
      expectTree(again);
      expect(again.nodes.map((n) => n.text)).toEqual(texts);
      expect(again.nodes.some((n) => n.branchKind)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("shows a label saved on a run the message now divides on both of its parts", () => {
    // Saved when the two replies were one node, so under both parts' keys.
    const d = session();
    const [first] = one(d, "Reading the importer.").stableIds!;
    const [second] = one(d, "Kept both parsers.").stableIds!;
    for (const k of [first, second]) writeMeta(BQ, k, { label: "the refactor" });
    const after = session();
    expect(one(after, "Reading the importer.").label).toBe("the refactor");
    expect(one(after, "Kept both parsers.").label).toBe("the refactor");
    expect(one(after, "keep the old parser too").label).toBeUndefined();
    // The load carried it to every member.
    for (const sid of [BQ, BN, BE]) for (const k of [first, second]) writeMeta(sid, k, { label: undefined });
  });

  it("gives a copied message the same identity in every session holding it", () => {
    const message = (sid: string) => parseFile(projectFile(sid)).nodes.find((n) => n.text === "keep the old parser too")!;
    expect(message(BN).stableIds).toEqual(message(BQ).stableIds);
    expect(message(BQ).stableIds![0]).toMatch(/^w:/);
  });

  it("leaves task notifications out, and counts only what the user typed", () => {
    const parsed = parseFile(projectFile(BQ));
    expect(parsed.nodes.some((n) => n.text.includes("Background task"))).toBe(false);
    expect(parsed.unreadMessages).toBe(1);
    expect(parseFile(projectFile(BN)).unreadMessages).toBe(0);
  });
});

describe("Claude Code's own notes (isMeta user records)", () => {
  const LOOP = "Checking the layout.\n\nThe layout matches.";
  const session = () => {
    const d = loadSession(HP)!;
    expectTree(d);
    return d;
  };
  const file = (sid: string) => path.join(projectDir("c--work-notes"), `${sid}.jsonl`);

  it("draws none of them, and the turns around them as one line of history", () => {
    const d = session();
    expect(pathToRoot(one(d, "Shipped.").id, toNodeMap(d.nodes)).map((n) => n.text)).toEqual([
      "Match this mockup",
      LOOP,
      "/brief",
      "Brief written.",
      "Ship it",
      "Shipped.",
    ]);
    expect(d.nodes.map((n) => n.text).sort()).toEqual(
      ["Match this mockup", LOOP, "/brief", "Brief written.", "Ship it", "Shipped.", "Try a darker theme", "Darker it is."].sort(),
    );
    // A "Continue" that went nowhere is no branch and no tip.
    expect(kidsOf(d, one(d, "Brief written."))).toEqual(["Ship it"]);
  });

  it("keeps a typed turn's cut through the notes that belong to it, though they aren't shown", () => {
    const d = session();
    const prompt = one(d, "Match this mockup");
    expect(prompt.lastRawId).toBe("hn-c1");
    expect(one(d, "/brief").lastRawId).toBe("hn-s1");
    const res = forkClaudeAt(HP, forkPointOf(prompt));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const copied = readJsonl(file(res.id)).filter((r) => r.type === "user");
    expect(copied.map((r) => !!r.isMeta)).toEqual([false, true]);
    // What the fork draws is what was selected, and nothing is added.
    expect(mergeSameRoleRuns(parseFile(file(res.id)).nodes).map((n) => n.text)).toEqual(["Match this mockup"]);
    expect(loadSession(HP)!.nodes.length).toBe(d.nodes.length);
    fs.rmSync(file(res.id));
  });

  it("forks a reply written around a note without drawing anything else", () => {
    // The API message's records stand either side of the tool result and its
    // caption, so the fork's chain runs through the note.
    const d = session();
    const res = forkClaudeAt(HP, forkPointOf(one(d, LOOP)));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readJsonl(file(res.id)).some((r) => r.isMeta && r.uuid && r.type === "user")).toBe(true);
    expect(mergeSameRoleRuns(parseFile(file(res.id)).nodes).map((n) => n.text)).toEqual(["Match this mockup", LOOP]);
    expect(loadSession(HP)!.nodes.length).toBe(d.nodes.length);
    fs.rmSync(file(res.id));
  });

  it("stitches copies of them, and ends a fork that stopped before one on the same turn", () => {
    const d = session();
    const prompt = one(d, "Match this mockup");
    const loop = one(d, LOOP);
    expect(new Set(prompt.heldBy)).toEqual(new Set([HP, HF, HQ]));
    expect(new Set(loop.heldBy)).toEqual(new Set([HP, HF]));
    expect(d.members.find((m) => m.id === HQ)!.tipId).toBe(prompt.id);
    expect(one(d, "Try a darker theme")).toMatchObject({ parentId: loop.id, branchKind: "fork" });
    expect(actionTarget(d, prompt, HQ).ref.sessionId).toBe(HQ);
    expect(actionTarget(d, loop, HQ).ref.sessionId).toBe(HP);
    expect(actionTarget(d, loop, HF).ref.sessionId).toBe(HF);
  });

  it("changes no identity of a turn still drawn", () => {
    const records = readRecords(file(HP))!;
    const earlier = parseRecords(HP, { records: records.map((r) => ({ ...r, isMeta: undefined })), bad: 0 }).nodes;
    const now = parseRecords(HP, { records, bad: 0 }).nodes;
    const before = new Map(earlier.map((n) => [n.id, n]));
    for (const n of now) expect(n.stableIds, n.text).toEqual(before.get(n.id)!.stableIds);
    // Only the notes leave.
    expect(earlier.filter((n) => !now.some((x) => x.id === n.id)).map((n) => n.id).sort()).toEqual(
      ["hn-c1", "hn-c2", "hn-k1", "hn-s1"].sort(),
    );
  });

  it("still counts one as activity", () => {
    const parsed = parseFile(file(HP));
    const brief = parsed.nodes.find((n) => n.text === "Brief written.")!;
    expect(brief.activeUntil).toBe(Date.parse("2026-10-01T10:20:00.000Z"));
  });
});

describe("A message delivered inside one API message", () => {
  const session = () => {
    const d = loadSession(BI)!;
    expectTree(d);
    return d;
  };
  const texts = ["Build it", "Starting.", "Also test it", "Done.", "Now a smaller one", "and check the logs", "Logs are clean."];

  it("is drawn where it was delivered, between the parts of the reply", () => {
    const d = session();
    expect(pathToRoot(one(d, "Logs are clean.").id, toNodeMap(d.nodes)).map((n) => n.text)).toEqual(texts);
    expect(d.nodes.length).toBe(texts.length);
    expect(d.members.find((m) => m.id === BI)!.tipId).toBe(one(d, "Logs are clean.").id);
  });

  it("gives the first drawn part the message's own key and a copy of each part the same", () => {
    const d = session();
    expect(one(d, "Starting.").stableIds).toEqual(["m:msg_bi1"]);
    // Its own content, not its place: a copy of one branch counts differently.
    expect(one(d, "Done.").stableIds).toEqual([`m:msg_bi1#${digest(JSON.stringify([{ type: "text", text: "Done." }]))}`]);
    // Nothing of its first block was drawn, so this is the part an earlier
    // parser keyed: a label saved on it is here.
    expect(one(d, "Logs are clean.").stableIds).toEqual(["m:msg_bi2"]);
  });

  it("counts the message's usage once, and every part knows the context it ended on", () => {
    const d = session();
    expect(one(d, "Starting.").usage).toBeDefined();
    expect(one(d, "Done.").usage).toBeUndefined();
    expect(one(d, "Done.").lastUsage).toEqual(one(d, "Starting.").usage);
  });

  describe("on two branches", () => {
    const branched = () => {
      const d = loadSession(BK)!;
      expectTree(d);
      return d;
    };
    const pathTo = (d: SessionDetail, text: string) =>
      pathToRoot(one(d, text).id, toNodeMap(d.nodes)).map((n) => n.text);

    it("draws each continuation under what it continues", () => {
      const d = branched();
      expect(pathTo(d, "After interruption.")).toEqual(["Start", "First.", "Interrupt", "After interruption."]);
      expect(pathTo(d, "Sibling continuation.")).toEqual(["Start", "First.", "Sibling continuation."]);
      expect(kidsOf(d, one(d, "First."))).toEqual(["Interrupt", "Sibling continuation."]);
      // Newest of the two: the session's tip is on the branch written last.
      expect(d.members.find((m) => m.id === BK)!.tipId).toBe(one(d, "Sibling continuation.").id);
    });

    it("forks each branch to exactly its path, the copy matching its parts", () => {
      for (const text of ["After interruption.", "Sibling continuation."]) {
        const d = branched();
        const res = forkClaudeAt(BK, forkPointOf(one(d, text)));
        expect(res.ok).toBe(true);
        if (!res.ok) continue;
        const file = path.join(projectDir("c--work-inside"), `${res.id}.jsonl`);
        expect(parseFile(file).nodes.map((n) => n.text)).toEqual(pathTo(d, text));
        const again = branched();
        expect(again.nodes.length).toBe(d.nodes.length);
        expect(new Set(one(again, text).heldBy)).toEqual(new Set([BK, res.id]));
        expect(one(again, text).stableIds).toEqual(one(d, text).stableIds);
        expect(one(again, text === "After interruption." ? "Sibling continuation." : "Interrupt").heldBy).toEqual([BK]);
        fs.rmSync(file);
      }
    });
  });

  it("cuts each part where it ends, and a fork of the first doesn't hold the message", () => {
    const d = session();
    const first = one(d, "Starting.");
    const message = one(d, "Also test it");
    expect(first.lastRawId).toBe("bi-a1");
    expect(new Set(first.heldBy)).toEqual(new Set([BI, BJ]));
    expect(message.heldBy).toEqual([BI]);
    expect(d.members.find((m) => m.id === BJ)!.tipId).toBe(first.id);
    expect(actionTarget(d, first, BJ).ref.sessionId).toBe(BJ);
    expect(actionTarget(d, message, BJ).ref.sessionId).toBe(BI);
    const res = forkClaudeAt(BI, forkPointOf(first));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const file = path.join(projectDir("c--work-inside"), `${res.id}.jsonl`);
    expect(mergeSameRoleRuns(parseFile(file).nodes).map((n) => n.text)).toEqual(["Build it", "Starting."]);
    fs.rmSync(file);
  });
});

describe("A key only a matched copy answers to", () => {
  const [P, F] = ["50000000-0000-4000-8000-00000000001f", "50000000-0000-4000-8000-000000000020"];
  const at = (min: number) => new Date(Date.UTC(2026, 9, 3, 10, min)).toISOString();
  const base = (sid: string) => ({ sessionId: sid, cwd: "C:\\work\\alias", isSidechain: false });
  const typed = (sid: string, uuid: string, parentUuid: string | null, min: number, text: string, extra = {}) => ({
    ...base(sid), type: "user", uuid, parentUuid, timestamp: at(min), message: { role: "user", content: text }, ...extra,
  });
  const ready = (sid: string, uuid: string, parentUuid: string) => ({
    ...base(sid), type: "assistant", uuid, parentUuid, timestamp: at(1),
    message: { id: "msg_alias", role: "assistant", content: [{ type: "text", text: "Ready." }] },
  });
  const forkedFrom = { forkedFrom: { sessionId: P, messageUuid: "p-a1" } };
  const parent = [typed(P, "p-u1", null, 0, "Begin", { promptId: "al-1" }), ready(P, "p-a1", "p-u1"), typed(P, "p-u2", "p-a1", 2, "Next")];
  const fork = [
    typed(F, "f-u1", null, 0, "Begin", { promptId: "al-1", ...forkedFrom }),
    { ...ready(F, "f-a1", "f-u1"), ...forkedFrom },
    typed(F, "f-n1", "f-a1", 2, "Continue from where you left off.", { isMeta: true, ...forkedFrom }),
    typed(F, "f-u2", "f-n1", 3, "Next", forkedFrom),
  ];
  const dir = () => projectDir("c--work-alias");
  /** The key the fork's "Next" was saved under, when its note was drawn. */
  const saved = () =>
    parseRecords(F, { records: readRecords(path.join(dir(), `${F}.jsonl`))!.map((r) => ({ ...r, isMeta: undefined })), bad: 0 })
      .nodes.find((n) => n.text === "Next")!.stableIds![0];

  it("reads and clears it across the family, leaving the parse it came from alone", () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${P}.jsonl`), parent.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(dir(), `${F}.jsonl`), fork.map((r) => JSON.stringify(r)).join("\n") + "\n");
    try {
      const key = saved();
      writeMeta(F, key, { label: "saved", status: "favorite", note: "why" });
      const d = loadSession(P)!;
      expectTree(d);
      expect(new Set(one(d, "Next").heldBy)).toEqual(new Set([P, F]));
      expect(one(d, "Next")).toMatchObject({ label: "saved", status: "favorite", note: "why" });
      annotate(P, one(d, "Next").id, { label: undefined, status: undefined, note: undefined });
      const after = loadSession(P)!;
      expect(one(after, "Next").label).toBeUndefined();
      expect(readMeta(F)[key]).toBeUndefined();
      expect(parseFile(path.join(dir(), `${P}.jsonl`)).nodes.find((n) => n.text === "Next")!.legacyIds ?? []).not.toContain(key);
    } finally {
      fs.rmSync(dir(), { recursive: true });
    }
  });
});

describe("Claude quiet fork endpoints", () => {
  it("ends a quiet fork at its own last reply, not inside the parent's merged run", () => {
    // Alone, the parent draws its agent loop as one reply...
    const alone = mergeSameRoleRuns(parseFile(path.join(projectDir("c--work-endpoint"), `${EP}.jsonl`)).nodes);
    expect(alone.map((n) => n.text)).toContain("First prose.\n\nLater prose.");
    // ...but the fork holds only the first part, so the family keeps them apart.
    const d = loadSession(EF)!;
    expectTree(d);
    const first = one(d, "First prose.");
    const later = one(d, "Later prose.");
    expect(later.parentId).toBe(first.id);
    expect(new Set(first.heldBy)).toEqual(new Set([EP, EF]));
    expect(later.heldBy).toEqual([EP]);
    expect(d.members.find((m) => m.id === EF)!.tipId).toBe(first.id);
    expect(d.members.find((m) => m.id === EP)!.tipId).toBe(later.id);
    // A fork at the quiet fork's endpoint cannot take in what it never had.
    expect(first.forkBlocked).toBeUndefined();
    const res = forkClaudeAt(EP, forkPointOf(first));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const file = path.join(projectDir("c--work-endpoint"), `${res.id}.jsonl`);
    expect(mergeSameRoleRuns(parseFile(file).nodes).map((n) => n.text)).toEqual([EP_PROMPT, "First prose."]);
    fs.rmSync(file);
  });

  /** Run `fn` while EF, the quiet fork, is not on disk. */
  const withoutEF = <T,>(fn: () => T): T => {
    const file = path.join(projectDir("c--work-endpoint"), `${EF}.jsonl`);
    const away = path.join(claudeRoot, `${EF}.away`);
    fs.renameSync(file, away);
    try {
      return fn();
    } finally {
      fs.renameSync(away, file);
    }
  };

  it("forks the range drawn when selected, though a quiet fork appearing before the click split it", () => {
    // Before EF exists, EP's agent loop is one node ending on "Later prose."...
    const point = withoutEF(() => forkPointOf(one(loadSession(EP)!, "First prose.\n\nLater prose.")));
    // ...then EF appears, and the same head id now draws only "First prose.".
    const now = loadSession(EP)!;
    expect(one(now, "First prose.").id).toBe(point.nodeId);
    const res = forkClaudeAt(EP, point);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const file = path.join(projectDir("c--work-endpoint"), `${res.id}.jsonl`);
    expect(mergeSameRoleRuns(parseFile(file).nodes).map((n) => n.text)).toEqual([EP_PROMPT, "First prose.\n\nLater prose."]);
    fs.rmSync(file);
  });

  it("refuses, rather than fork a longer range, when the selected node was folded into a longer one", () => {
    const point = forkPointOf(one(loadSession(EP)!, "First prose."));
    const before = fs.readdirSync(projectDir("c--work-endpoint")).length;
    // EF is deleted before the click: "First prose." merges with "Later prose." under the same head.
    const res = withoutEF(() => forkClaudeAt(EP, point));
    expect(res).toEqual({ ok: false, error: FORK_POINT_GONE });
    expect(fs.readdirSync(projectDir("c--work-endpoint")).length).toBe(before);
  });

  it("ends a quiet fork at the first of two user records", () => {
    const d = loadSession(UF)!;
    expectTree(d);
    expect(d.meta.id).toBe(UP);
    const first = one(d, "First ask");
    expect(one(d, "Second ask").parentId).toBe(first.id);
    expect(d.members.find((m) => m.id === UF)).toMatchObject({ parentId: UP, parentEvidence: "explicit", tipId: first.id });
  });

  it("opens and resumes the focused quiet fork on the history it shares, and the parent elsewhere", () => {
    const d = loadSession(EP)!;
    const first = one(d, "First prose.");
    const later = one(d, "Later prose.");
    // The shared reply is drawn as the parent's, but the fork holds it too.
    expect(first.sourceSessionId).toBe(EP);
    expect(actionTarget(d, first, EF).ref).toEqual({ provider: "claude", sessionId: EF, cwd: "C:\\work\\demo" });
    expect(actionTarget(d, first, EF).member.resumeCommand).toContain(EF);
    // Opened on the parent, or on a turn the fork doesn't hold: the parent.
    expect(actionTarget(d, first, null).ref.sessionId).toBe(EP);
    expect(actionTarget(d, later, EF).ref.sessionId).toBe(EP);
  });
});

describe("Claude annotations", () => {
  it("resolves a label saved against a copy that stitching folded away", () => {
    // Saved while F stood alone, under F's own uuid for the shared reply.
    writeMeta(F, "f-a2", { label: "tests landed" });
    const d = loadSession(P)!;
    const n = one(d, "Added vitest.");
    expect(n.id).toBe("p-a2");
    expect(n.label).toBe("tests landed");
  });
});

describe("Claude fork", () => {
  it("writes a new transcript in the extension's fork format and stitches it back", () => {
    const before = loadSession(P)!;
    const shipped = one(before, "Added vitest.");
    const res = forkClaudeAt(P, forkPointOf(shipped));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.open).toEqual({ provider: "claude", sessionId: res.id, cwd: "C:\\work\\demo" });
    expect(readLineage()[res.id]).toBe(P);

    const lines = readJsonl(path.join(projectDir(), `${res.id}.jsonl`));
    expect(lines.at(-1)).toMatchObject({ type: "custom-title", customTitle: "Build walkthrough (fork)" });
    const recs = lines.slice(0, -1);
    // Chain up to and including the anchor, re-linked, re-owned, marked.
    expect(recs.map((r) => r.message?.id ?? r.promptId)).toEqual(["prompt-1", "msg_1", "msg_1", "prompt-2", "msg_2"]);
    expect(recs[0].parentUuid).toBeNull();
    for (let i = 1; i < recs.length; i++) expect(recs[i].parentUuid).toBe(recs[i - 1].uuid);
    expect(recs.every((r) => r.sessionId === res.id)).toBe(true);
    expect(recs.every((r) => r.forkedFrom?.sessionId === P)).toBe(true);
    expect(new Set(recs.map((r) => r.uuid)).size).toBe(recs.length);
    expect(recs.some((r) => r.uuid.startsWith("p-"))).toBe(false);

    // Until it has a turn of its own, the fork adds nothing to the tree...
    const after = loadSession(P)!;
    expectTree(after);
    expect(after.members.map((m) => m.id)).toContain(res.id);
    expect(after.nodes.length).toBe(before.nodes.length);
    // ...and opening the tree on it lands on the turn it was forked at.
    expect(after.members.find((m) => m.id === res.id)!.tipId).toBe(shipped.id);
    // ...and the original transcript is untouched.
    expect(fs.readFileSync(path.join(projectDir(), `${P}.jsonl`), "utf8")).not.toContain(res.id);
  });

  it("forks at a node inside a fork's own suffix from that fork's transcript", () => {
    const d = loadSession(P)!;
    const res = forkClaudeAt(P, forkPointOf(one(d, "Switched to rollup.")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recs = readJsonl(path.join(projectDir(), `${res.id}.jsonl`));
    expect(recs[0].forkedFrom.sessionId).toBe(F);
    expect(recs.at(-1).customTitle).toBe("Build walkthrough (fork) (fork)");
  });

  it("path to a stitched node runs through the shared prefix", () => {
    const d = loadSession(P)!;
    const texts = pathToRoot(one(d, "Switched to rollup.").id, toNodeMap(d.nodes)).map((n) => n.text);
    expect(texts).toEqual(["Explain the build", "The build uses esbuild.", "Now add tests", "Added vitest.", "Try rollup instead", "Switched to rollup."]);
  });

  it("copies the logical chain across /compact, keeping the boundary a physical root", () => {
    const before = loadSession(KP)!;
    const res = forkClaudeAt(KP, forkPointOf(one(before, "Issue two fixed.")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recs = readJsonl(path.join(projectDir("c--work-compact"), `${res.id}.jsonl`)).slice(0, -1);
    expect(recs.map((r) => r.subtype ?? r.message?.id ?? r.promptId ?? "summary")).toEqual([
      "kp-1", "msg_k1", "compact_boundary", "summary", "msg_k2", "kp-3", "msg_k3",
    ]);
    const cb = recs.find((r) => r.subtype === "compact_boundary");
    expect(cb.parentUuid).toBeNull();
    // The fork is one family with its source, and adds no node of its own yet.
    const after = loadSession(KP)!;
    expectTree(after);
    expect(after.members).toHaveLength(3);
    expect(after.nodes.length).toBe(before.nodes.length);
  });

  it("refuses a pre-compact turn with the reason the panel showed", () => {
    const d = loadSession(KP)!;
    const res = forkClaudeAt(KP, forkPointOf(one(d, "Found four issues.")));
    expect(res).toEqual({ ok: false, error: one(d, "Found four issues.").forkBlocked });
  });

  it("a fork ending on a prompt without promptId re-joins its source", () => {
    const before = loadSession(NP)!;
    const res = forkClaudeAt(NP, forkPointOf(one(before, "Second question")));
    expect(res.ok).toBe(true);
    const after = loadSession(NP)!;
    expectTree(after);
    expect(after.members).toHaveLength(2);
    one(after, "Second question");
    expect(after.nodes.length).toBe(before.nodes.length);
  });

  it("carries an annotation saved before stable ids forward, so it outlives the root", () => {
    // The pre-upgrade sidecar: one entry, under the root's own uuid.
    writeMeta(PA, "pa-a1", { label: "existing annotation" });
    expect(one(loadSession(PA)!, "Two options.").label).toBe("existing annotation");
    // Loading copied it under the turn's stable id into every member's file...
    expect(JSON.parse(fs.readFileSync(path.join(process.env.AGENTREE_HOME!, "meta", `${PB}.json`), "utf8"))).toMatchObject({
      "m:msg_pa1": { label: "existing annotation" },
    });
    // ...so the root can go and the fork still shows it.
    fs.rmSync(path.join(projectDir("c--work-preamble"), `${PA}.jsonl`));
    expect(one(loadSession(PB)!, "Two options.").label).toBe("existing annotation");
  });

  it("annotations survive the session they were made in being deleted", () => {
    // Annotated on the family (written to every member, under every id)...
    annotate(P1, one(loadSession(P1)!, "Step one is tagging.").id, { label: "keep" });
    // ...then the root transcript goes away. Its forks still carry the turn.
    fs.rmSync(path.join(projectDir("c--work-lineage"), `${P1}.jsonl`));
    const d = loadSession(F1)!;
    expect(d.meta.id).toBe(F1);
    expect(one(d, "Step one is tagging.").label).toBe("keep");
  });
});

describe("Claude annotations across identity schemes and membership", () => {
  const sidecar = (id: string) => readMeta(id);

  it("finds labels saved under earlier identity schemes, and carries them forward", () => {
    // Scheme 2 folded whitespace in a prompt's digest...
    const folded = `u:ep-1|${foldedDigest(EP_PROMPT)}`;
    writeMeta(EP, folded, { label: "folded key" });
    // ...and wrote a prompt without a promptId as a literal chain.
    const literal = `u:|${foldedDigest("Second question")}@m:msg_n1`;
    writeMeta(NP, literal, { label: "literal chain" });
    // Scheme 3 keyed a prompt id with its exact text, as `u:`.
    const scheme3 = `u:up-1|${digest("First ask")}`;
    writeMeta(UP, scheme3, { status: "favorite" });

    expect(one(loadSession(EP)!, EP_PROMPT).label).toBe("folded key");
    expect(one(loadSession(NP)!, "Second question").label).toBe("literal chain");
    expect(one(loadSession(UP)!, "First ask").status).toBe("favorite");
    // Carried forward under the current keys, into every member's sidecar.
    for (const id of [EP, EF]) expect(sidecar(id)[`p:ep-1|${digest(EP_PROMPT)}`]).toEqual({ label: "folded key" });
    expect(sidecar(NP)[qualify(`u:|${digest("Second question")}`, "m:msg_n1")]).toEqual({ label: "literal chain" });
    for (const id of [UP, UF]) expect(sidecar(id)[`p:up-1|${digest("First ask")}`]).toEqual({ status: "favorite" });

    // Clearing it clears the old entries too: nothing resurfaces.
    annotate(EP, one(loadSession(EP)!, EP_PROMPT).id, { label: null as unknown as undefined });
    expect(sidecar(EP)[folded]).toBeUndefined();
    expect(one(loadSession(EP)!, EP_PROMPT).label).toBeUndefined();
  });

  it("gives an old key two prompts shared to neither of them", () => {
    // Scheme 2 keyed the two indentations alike; that entry is ambiguous.
    writeMeta(WP, `u:|${foldedDigest(GUARD_OUT)}@m:msg_wi1`, { label: "which one?" });
    const d = loadSession(WP)!;
    expect(one(d, GUARD_OUT).label).toBeUndefined();
    expect(one(d, GUARD_IN).label).toBeUndefined();
  });

  it("keeps a label made before a fork existed once the original is deleted", () => {
    const dir = projectDir("c--work-growth");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(claudeRoot, "growth-src", "c--work-growth");
    fs.copyFileSync(path.join(src, `${GP}.jsonl`), path.join(dir, `${GP}.jsonl`));
    annotate(GP, one(loadSession(GP)!, "Postgres.").id, { label: "chosen" });
    expect(sidecar(GF)).toEqual({});

    // The fork appears; loading the family gives its sidecar the label too.
    fs.copyFileSync(path.join(src, `${GF}.jsonl`), path.join(dir, `${GF}.jsonl`));
    expect(loadSession(GP)!.members.map((m) => m.id).sort()).toEqual([GP, GF].sort());
    expect(sidecar(GF)).toEqual({ "m:msg_gr1": { label: "chosen" } });
    // Once the sidecars agree, a load writes nothing.
    const stamp = () => [GP, GF].map((id) => fs.statSync(path.join(process.env.AGENTREE_HOME!, "meta", `${id}.json`)).mtimeMs);
    const before = stamp();
    loadSession(GF);
    expect(stamp()).toEqual(before);

    fs.rmSync(path.join(dir, `${GP}.jsonl`));
    const d = loadSession(GF)!;
    expect(d.meta.id).toBe(GF);
    expect(one(d, "Postgres.").label).toBe("chosen");
  });
});

describe("Claude metadata across copies of one session", () => {
  /** Copy a session's copies into projects/, oldest write first. */
  const place = (id: string, dirs: string[]) => {
    const t = Date.now() / 1000 - 3600;
    dirs.forEach((name, i) => {
      fs.mkdirSync(projectDir(name), { recursive: true });
      const to = path.join(projectDir(name), `${id}.jsonl`);
      fs.copyFileSync(path.join(claudeRoot, "copies-src", name, `${id}.jsonl`), to);
      fs.utimesSync(to, t + i * 60, t + i * 60);
    });
  };

  it("takes a rename from the copy written last, though every record it has is in the other", () => {
    place(RNS, ["c--work-rn-old", "c--work-rn-new"]);
    expect(listSessions().filter((s) => s.id === RNS)).toEqual([expect.objectContaining({ title: "Renamed in copy" })]);
    const d = loadSession(RNS)!;
    expectTree(d);
    // The conversation is still the larger copy's.
    one(d, "Done too.");
  });

  it("keeps a diverged copy's rename made before its first new record", () => {
    place(DV, ["c--work-dv-a", "c--work-dv-b"]);
    expect(listSessions().find((s) => s.id === DV)!.title).toBe("Named before diverging");
    const d = loadSession(DV)!;
    expectTree(d);
    expect(kidsOf(d, one(d, "Drafted."))).toEqual(["Longer", "Shorter"]);
  });
});

describe("Claude family split", () => {
  it("splits when the member bridging two others is deleted, each side keeping its own turns' identities", () => {
    const dir = projectDir("c--work-split-family");
    fs.mkdirSync(dir, { recursive: true });
    for (const id of [SP4, SB4, SF4]) {
      fs.copyFileSync(path.join(claudeRoot, "split-src", "c--work-split-family", `${id}.jsonl`), path.join(dir, `${id}.jsonl`));
    }
    const before = loadSession(SF4)!;
    expect(before.members.map((m) => m.id).sort()).toEqual([SP4, SB4, SF4].sort());
    const own = one(before, "Cron at 2am.");

    fs.rmSync(path.join(dir, `${SB4}.jsonl`));
    // The root still loads — but SF4 is no longer in its family.
    expect(loadSession(SP4)!.members.map((m) => m.id)).toEqual([SP4]);
    const after = loadSession(SF4)!;
    expectTree(after);
    expect(after.members.map((m) => m.id)).toEqual([SF4]);
    // So a reload can carry the selection over by semantic identity.
    expect(one(after, "Cron at 2am.").stableIds).toEqual(own.stableIds);
  });
});

describe("Claude parentage evidence", () => {
  it("keeps creation order over a renamed title, and says the direction is inferred", async () => {
    // Created P3 → F3 → G3, a second apart; G3 was renamed, so its title
    // carries no "(fork)". Title order alone would make it F3's parent.
    const dir = projectDir("c--work-rename");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(claudeRoot, "rename-src", "c--work-rename");
    let born = 0;
    for (const id of [P3, F3, G3]) {
      // Past the last file's time on the clock file times come from, not a
      // fixed sleep: a VM's wall clock can step back while a timer runs.
      while (Date.now() < born + 1100) await new Promise((r) => setTimeout(r, 25));
      // Written, not copied: a harness writes a new file, and macOS's copy
      // keeps the source's creation time, which would make all three one batch.
      const file = path.join(dir, `${id}.jsonl`);
      fs.writeFileSync(file, fs.readFileSync(path.join(src, `${id}.jsonl`)));
      born = fs.statSync(file).birthtimeMs;
    }
    const d = loadSession(G3)!;
    expectTree(d);
    expect(d.meta.id).toBe(P3);
    const member = (id: string) => d.members.find((m) => m.id === id)!;
    expect(member(F3)).toMatchObject({ parentId: P3, parentEvidence: "inferred" });
    expect(member(G3)).toMatchObject({ parentId: F3, parentEvidence: "inferred" });
    // F3's own turn is F3's, and the dashed edge is where G3 begins.
    expect(one(d, "End with a question.").sourceSessionId).toBe(F3);
    expect(one(d, "Which question?")).toMatchObject({ branchKind: "fork", sourceSessionId: G3 });
  }, 15_000);
});

describe("Fork invariants over every fixture family", () => {
  /**
   * The displayed text of a path, exactly — whitespace is meaning. Joined,
   * because the family and the fork alone can group the same parts into
   * different nodes (a quiet fork's endpoint splits a run the fork alone merges).
   */
  const flat = (texts: string[]) => texts.join("\n\n");

  it("every enabled fork holds exactly what the selected node shows, and adds nothing to the tree", () => {
    let checked = 0;
    for (const s of listSessions()) {
      const before = loadSession(s.id)!;
      const map = toNodeMap(before.nodes);
      for (const n of before.nodes) {
        if (n.forkBlocked) continue;
        const res = forkClaudeAt(s.id, forkPointOf(n));
        expect(res.ok, `${s.id}: ${n.text}`).toBe(true);
        if (!res.ok) continue;
        checked++;
        // The fork's own transcript, alone, draws the selected path — all of
        // it (nothing shown is left out) and nothing after it.
        const file = path.join(path.dirname(locateFile(res.id)), `${res.id}.jsonl`);
        const own = mergeSameRoleRuns(parseFile(file).nodes);
        expect(flat(own.map((x) => x.text)), n.text).toBe(flat(pathToRoot(n.id, map).map((x) => x.text)));
        // And an unchanged fork stitches in completely: no node, no root added.
        const after = loadSession(s.id)!;
        expectTree(after);
        expect(after.nodes.length, `fork of "${n.text}" added history`).toBe(before.nodes.length);
        fs.rmSync(file);
      }
    }
    expect(checked).toBeGreaterThan(30);
  }, 60_000);

  it("a fork of a compacted fork keeps the pre-compact history (second generation)", () => {
    // KN is the extension's fork of compacted KP: its boundary's logical
    // parent points into KP. Forking KN's own reply must still copy it all.
    const d = loadSession(KN)!;
    const res = forkClaudeAt(KN, forkPointOf(one(d, "Issue three fixed.")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recs = readJsonl(path.join(projectDir("c--work-compact"), `${res.id}.jsonl`));
    expect(recs[0].message.content).toBe("Audit the module");
    const boundary = recs.find((r) => r.subtype === "compact_boundary");
    expect(boundary.parentUuid).toBeNull();
    // Its logical link points INSIDE the copy now.
    expect(recs.some((r) => r.uuid === boundary.logicalParentUuid)).toBe(true);
    const after = loadSession(KN)!;
    expectTree(after);
    expect(after.nodes.filter((n) => n.parentId === null)).toHaveLength(1);
    expect(after.nodes.length).toBe(d.nodes.length);
  });
});

function locateFile(id: string): string {
  for (const dir of fs.readdirSync(projects)) {
    const f = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`no transcript for ${id}`);
}
