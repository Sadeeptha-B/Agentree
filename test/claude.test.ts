import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { childIndex, pathToRoot, toNodeMap } from "../shared/render.ts";
import { listSessions, loadSession, claudeHealth } from "../electron/transcripts.ts";
import { forkClaudeAt } from "../electron/providers/claude-fork.ts";
import { readLineage } from "../electron/lineage.ts";

const P = "11111111-1111-4111-8111-111111111111";
const F = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
let projectDir: string;

beforeAll(() => {
  // Work on a copy: the fork tests write a new transcript.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-claude-"));
  fs.cpSync(path.join(__dirname, "fixtures", "claude", "2.1"), path.join(tmp, "claude"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
  process.env.AGENTREE_HOME = path.join(tmp, "agentree");
  projectDir = path.join(tmp, "claude", "projects", "c--work-demo");
});

describe("Claude transcripts", () => {
  it("lists one entry per fork family and never merges on an opening prompt alone", () => {
    const list = listSessions();
    expect(list.map((s) => s.id).sort()).toEqual([P, S]);
    const fam = list.find((s) => s.id === P)!;
    expect(fam.members).toBe(2);
    expect(list.find((s) => s.id === S)!.members).toBe(1);
  });

  it("titles from ai-title, never the IDE wrapper", () => {
    const fam = listSessions().find((s) => s.id === P)!;
    expect(fam.title).toBe("Build walkthrough");
    expect(fam.entrypoint).toBe("claude-vscode");
    const solo = listSessions().find((s) => s.id === S)!;
    expect(solo.title).toBe("Explain the build");
  });

  it("drops ide_* context from turn text and ignores api-request-blob records", () => {
    const d = loadSession(P)!;
    const first = d.nodes.find((n) => n.parentId === null)!;
    expect(first.text).toBe("Explain the build");
    expect(d.nodes.some((n) => n.text.includes("NOT A TURN"))).toBe(false);
  });

  it("stitches the extension fork in at the turn it was taken after", () => {
    for (const id of [P, F]) {
      const d = loadSession(id)!;
      expect(d.meta.id).toBe(P); // any member opens the family
      const kids = childIndex(d.nodes);
      const added = d.nodes.find((n) => n.text === "Added vitest.")!;
      const branch = (kids.get(added.id) ?? []).map((n) => n.text).sort();
      // Two rewind branches inside P, plus the fork's own first prompt.
      expect(branch).toEqual(["Actually, wait", "Ship it", "Try rollup instead"]);
      const forkTurn = d.nodes.find((n) => n.text === "Try rollup instead")!;
      expect(forkTurn.crossSession).toBe(true);
      expect(forkTurn.sourceSessionId).toBe(F);
      // The shared prefix exists once.
      expect(d.nodes.filter((n) => n.text === "Explain the build")).toHaveLength(1);
      expect(d.meta.branchPoints).toBe(1);
      expect(d.members.find((m) => m.id === F)!.parentId).toBe(P);
    }
  });

  it("reports health with no unknown record types", () => {
    listSessions();
    const h = claudeHealth();
    expect(h.filesSeen).toBe(3);
    expect(h.sessionsParsed).toBe(3);
    expect(h.listed).toBe(2);
    expect(h.unknownRecordTypes).toEqual({});
  });
});

describe("Claude fork", () => {
  it("writes a new transcript in the extension's fork format and stitches it back", () => {
    const before = loadSession(P)!;
    const shipped = before.nodes.find((n) => n.text === "Added vitest.")!;
    const res = forkClaudeAt(P, shipped.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.open).toEqual({ provider: "claude", sessionId: res.id, cwd: "C:\\work\\demo" });
    expect(readLineage()[res.id]).toBe(P);

    const lines = fs
      .readFileSync(path.join(projectDir, `${res.id}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const title = lines[lines.length - 1];
    expect(title).toMatchObject({ type: "custom-title", customTitle: "Build walkthrough (fork)" });
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
    expect(after.members.map((m) => m.id)).toContain(res.id);
    expect(after.nodes.length).toBe(before.nodes.length);
    // ...and the original transcript is untouched.
    expect(fs.readFileSync(path.join(projectDir, `${P}.jsonl`), "utf8")).not.toContain(res.id);
  });

  it("forks at a node inside a fork's own suffix from that fork's transcript", () => {
    const d = loadSession(P)!;
    const n = d.nodes.find((x) => x.text === "Switched to rollup.")!;
    const res = forkClaudeAt(P, n.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recs = fs
      .readFileSync(path.join(projectDir, `${res.id}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(recs[0].forkedFrom.sessionId).toBe(F);
    expect(recs.at(-1).customTitle).toBe("Build walkthrough (fork) (fork)");
  });

  it("path to a stitched node runs through the shared prefix", () => {
    const d = loadSession(P)!;
    const leaf = d.nodes.find((n) => n.text === "Switched to rollup.")!;
    const texts = pathToRoot(leaf.id, toNodeMap(d.nodes)).map((n) => n.text);
    expect(texts).toEqual(["Explain the build", "The build uses esbuild.", "Now add tests", "Added vitest.", "Try rollup instead", "Switched to rollup."]);
  });
});
