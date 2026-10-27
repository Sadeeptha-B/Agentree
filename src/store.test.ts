// Lives in src/ (not test/) so it type-checks with the renderer's DOM config.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberInfo, SessionDetail, TurnNode } from "../shared/types.ts";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  listSessions: vi.fn(async () => []),
  providerHealth: vi.fn(async () => []),
  patchNode: vi.fn(async (_sessionId: string, _nodeId: string, _patch: unknown) => {}),
  onUpdateAvailable: vi.fn(() => () => {}),
}));
vi.mock("./api.ts", () => ({ api }));

const { useStore } = await import("./store.ts");

const node = (id: string, parentId: string | null, text: string, stable: string, sourceSessionId: string): TurnNode => ({
  id,
  parentId,
  role: parentId ? "assistant" : "user",
  text,
  timestamp: 1,
  stableIds: [stable],
  sourceSessionId,
});
const member = (id: string, parentId: string | null): MemberInfo => ({
  id,
  title: id,
  parentId,
  cwd: "",
  resumeCommand: "",
  activeAt: 0,
  touchedAt: 0,
});
const detail = (rootId: string, nodes: TurnNode[], members: MemberInfo[]): SessionDetail => ({
  meta: {
    id: rootId,
    provider: "claude",
    cwd: "",
    project: "",
    title: rootId,
    activeAt: 0,
    touchedAt: 0,
    nodeCount: nodes.length,
    branchPoints: 0,
    resumeCommand: "",
    members: members.length,
  },
  nodes,
  members,
});

/** The family as drawn while P exists, and as F alone draws it after P is deleted. */
const withRoot = detail(
  "P",
  [node("p-u1", null, "Q", "u:q", "P"), node("p-a1", "p-u1", "A", "m:a", "P"), node("f-u2", "p-a1", "Q2", "u:q2", "F")],
  [member("P", null), member("F", "P")],
);
const reRooted = detail(
  "F",
  [node("f-u1", null, "Q", "u:q", "F"), node("f-a1", "f-u1", "A", "m:a", "F"), node("f-u2", "f-a1", "Q2", "u:q2", "F")],
  [member("F", null)],
);

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ session: null, nodes: new Map(), children: new Map(), selected: null, error: null });
});

describe("renderer store lifecycle", () => {
  it("a reload that resolves after the view was closed doesn't reopen it", async () => {
    api.getSession.mockResolvedValueOnce(withRoot);
    await useStore.getState().openSession("P");
    let resolve!: (d: SessionDetail) => void;
    api.getSession.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const reload = useStore.getState().reloadSession();
    useStore.getState().close();
    resolve(withRoot);
    await reload;
    expect(useStore.getState().session).toBeNull();
  });

  it("follows a family whose root was deleted onto a surviving member, keeping the selection", async () => {
    api.getSession.mockResolvedValueOnce(withRoot);
    await useStore.getState().openSession("P");
    useStore.getState().select("p-a1"); // reading history, not following the tip
    // P is gone; F survives and is now the family's root.
    api.getSession.mockImplementation(async (id: string) => (id === "F" ? reRooted : null));
    await useStore.getState().reloadSession();
    const s = useStore.getState();
    expect(s.session?.meta.id).toBe("F");
    expect(api.getSession).toHaveBeenCalledWith("F");
    // The same turn, under the id it has in F.
    expect(s.selected).toBe("f-a1");
  });

  it("says so when no member of the family is left", async () => {
    api.getSession.mockResolvedValueOnce(withRoot);
    await useStore.getState().openSession("P");
    api.getSession.mockResolvedValue(null);
    await useStore.getState().reloadSession();
    expect(useStore.getState().error).toMatch(/no longer on disk/);
  });

  it("sends a cleared annotation field as null, which survives JSON", async () => {
    api.getSession.mockResolvedValueOnce(withRoot);
    await useStore.getState().openSession("P");
    await useStore.getState().patch("p-a1", { label: undefined });
    expect(api.patchNode).toHaveBeenCalledWith("P", "p-a1", { label: null });
    expect(JSON.parse(JSON.stringify(api.patchNode.mock.calls[0][2]))).toEqual({ label: null });
  });
});
