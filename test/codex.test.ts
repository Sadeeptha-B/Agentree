import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { childIndex, pathToRoot, toNodeMap } from "../shared/render.ts";

const forkThread = vi.fn();
vi.mock("../electron/providers/codex-appserver.ts", () => ({ forkThread: (...a: unknown[]) => forkThread(...a) }));

const { listCodexSessions, loadCodexSession, codexHealth, forkCodexAt } = await import(
  "../electron/providers/codex.ts"
);

const T1 = "01900000-0000-7000-8000-000000000001";
const T2 = "01900000-0000-7000-8000-000000000002";
const T3 = "01900000-0000-7000-8000-000000000003";
const T4 = "01900000-0000-7000-8000-000000000004";
const G = "01900000-0000-7000-8000-000000000009";
const L = "01800000-0000-7000-8000-000000000001";

beforeAll(() => {
  process.env.CODEX_HOME = path.join(__dirname, "fixtures", "codex", "0.162", "home");
  process.env.AGENTREE_HOME = path.join(__dirname, "fixtures", "no-agentree-home");
});

describe("Codex paginated rollouts", () => {
  it("lists families, hides guardian threads, names from session_index", () => {
    const list = listCodexSessions();
    const ids = list.map((s) => s.id).sort();
    expect(ids).toEqual([L, T1, T4].sort());
    expect(ids).not.toContain(G);
    const fam = list.find((s) => s.id === T1)!;
    expect(fam.title).toBe("X investigation");
    expect(fam.members).toBe(3); // T1, archived T3, T2
  });

  it("builds forks AND prompt edits into one exact tree", () => {
    const d = loadCodexSession(T2)!;
    expect(d.meta.id).toBe(T1);
    const kids = childIndex(d.nodes);
    const answerA = d.nodes.find((n) => n.text.endsWith("X is Y."))!;
    // After turn A: the original B, the edited B', and the fork into T3.
    const after = (kids.get(answerA.id) ?? []).map((n) => n.text).sort();
    expect(after).toEqual(["Explain differently", "Explain more", "Fork question"]);
    const edit = d.nodes.find((n) => n.text === "Explain differently")!;
    const fork = d.nodes.find((n) => n.text === "Fork question")!;
    const plain = d.nodes.find((n) => n.text === "Explain more")!;
    expect(edit.crossSession).toBe(true);
    expect(fork.crossSession).toBe(true);
    expect(plain.crossSession).toBeUndefined();
    expect(fork.sourceSessionId).toBe(T3);

    const leaf = d.nodes.find((n) => n.text.includes("Grandchild answer."))!;
    expect(pathToRoot(leaf.id, toNodeMap(d.nodes)).map((n) => n.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    expect(d.members.find((m) => m.id === T3)).toMatchObject({ archived: true, parentId: T1 });
    expect(d.members.find((m) => m.id === T2)!.parentId).toBe(T3);
  });

  it("strips the VS Code context wrapper and folds commentary + final into one reply", () => {
    const d = loadCodexSession(T1)!;
    const root = d.nodes.find((n) => n.parentId === null)!;
    expect(root.text).toBe("What is X?");
    const reply = d.nodes.find((n) => n.parentId === root.id)!;
    expect(reply.text).toBe("Looking.\n\nX is Y.");
    expect(reply.toolUses).toEqual(["shell"]);
    expect(reply.thinking).toBe("Thinking it over.");
    expect(reply.usage).toMatchObject({ input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 50 });
  });

  it("marks a steering message typed mid-turn", () => {
    const d = loadCodexSession(T1)!;
    expect(d.nodes.find((n) => n.text === "also this")!.midTurn).toBe(true);
  });

  it("reads zstd pages, warns about a missing base, stitches legacy forks", () => {
    listCodexSessions();
    const h = codexHealth();
    expect(h.error).toBeUndefined();
    expect(h.skipped).toBe(1); // guardian
    expect(h.warnings.join(" ")).toMatch(/no longer on disk/);
    expect(h.unknownRecordTypes).toEqual({});

    const legacy = loadCodexSession(L)!;
    const kids = childIndex(legacy.nodes);
    const hi = legacy.nodes.find((n) => n.text === "Legacy hi.")!;
    expect((kids.get(hi.id) ?? []).map((n) => n.text).sort()).toEqual([
      "Legacy fork continues",
      "Legacy parent continues",
    ]);
  });
});

describe("Codex fork", () => {
  it("forks by thread when the turn is on the thread's current history", async () => {
    forkThread.mockResolvedValueOnce({ ok: true, threadId: "new-thread-1", cwd: "C:\\work\\codex-demo" });
    const d = loadCodexSession(T1)!;
    const edited = d.nodes.find((n) => n.text === "Different detail." || n.text.endsWith("Different detail."))!;
    const res = await forkCodexAt(T1, edited.id);
    expect(forkThread).toHaveBeenLastCalledWith({
      threadId: T1,
      lastTurnId: "01900000-0000-7000-8000-0000000a0003",
      path: undefined,
    });
    expect(res).toMatchObject({ ok: true, id: "new-thread-1", open: { provider: "codex", sessionId: "new-thread-1" } });
  });

  it("forks by page file when the turn was cut away by a prompt edit", async () => {
    forkThread.mockResolvedValueOnce({ ok: true, threadId: "new-thread-2", cwd: "" });
    const d = loadCodexSession(T1)!;
    const old = d.nodes.find((n) => n.text.endsWith("More detail."))!;
    const res = await forkCodexAt(T1, old.id);
    const call = forkThread.mock.lastCall![0] as { threadId: string; path?: string };
    expect(call.threadId).toBe(T1);
    expect(path.basename(call.path!)).toBe(`rollout-2026-10-01T10-00-00-${T1}.jsonl`);
    expect(res.ok && res.note).toMatch(/prompt-edit branch/);
  });

  it("refuses legacy rollouts, which have no turn ids", async () => {
    const d = loadCodexSession(L)!;
    const res = await forkCodexAt(L, d.nodes[0].id);
    expect(res.ok).toBe(false);
  });
});
