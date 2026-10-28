// Lives in src/ (not test/) so it type-checks with the renderer's DOM config.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DayActivity, DayFound, DayTurn, DayWant, MemberInfo, SessionDetail, SettingsState, TurnNode } from "../shared/types.ts";
import { actionTarget } from "../shared/render.ts";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  getDay: vi.fn(),
  listSessions: vi.fn(async () => []),
  providerHealth: vi.fn(async () => []),
  patchNode: vi.fn(async (_sessionId: string, _nodeId: string, _patch: unknown) => {}),
  onUpdateAvailable: vi.fn(() => () => {}),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
}));
vi.mock("./api.ts", () => ({ api }));

const { useStore } = await import("./store.ts");
const { dayBounds, dayKeyOf } = await import("./day.ts");

const node = (
  id: string,
  parentId: string | null,
  text: string,
  stable: string,
  sourceSessionId: string,
  heldBy = [sourceSessionId],
): TurnNode => ({
  id,
  parentId,
  role: parentId ? "assistant" : "user",
  text,
  timestamp: 1,
  stableIds: [stable],
  sourceSessionId,
  heldBy,
});
const member = (id: string, parentId: string | null): MemberInfo => ({
  id,
  title: id,
  parentId,
  cwd: `/work/${id}`,
  resumeCommand: `resume ${id}`,
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

/**
 * A parent P (Q → A → Q2 → A2) and a quiet fork F taken after A: F's history
 * is P's first two turns, drawn as P's.
 */
const quiet = detail(
  "P",
  [
    node("p-u1", null, "Q", "u:q", "P", ["P", "F"]),
    node("p-a1", "p-u1", "A", "m:a", "P", ["P", "F"]),
    node("p-u2", "p-a1", "Q2", "u:q2", "P"),
    node("p-a2", "p-u2", "A2", "m:a2", "P"),
  ],
  [member("P", null), { ...member("F", "P"), tipId: "p-a1" }],
);
/** The ref the panel's open / resume buttons get for the current state. */
const target = () => {
  const s = useStore.getState();
  return actionTarget(s.session!, s.nodes.get(s.selected!), s.focus).ref;
};

const settingsState = (rememberView: boolean, view?: SettingsState["settings"]["view"]): SettingsState => ({
  settings: {
    sortBy: "active",
    providers: { claude: true, codex: true, copilot: true },
    showArchivedCodex: false,
    rememberView,
    ...(view ? { view } : {}),
    paths: {},
    updateCheck: true,
  },
  env: {},
  updateCheckDisabledByEnv: false,
  file: "settings.json",
});

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    session: null,
    nodes: new Map(),
    children: new Map(),
    selected: null,
    focus: null,
    error: null,
    annotationError: null,
    expanded: new Set(),
    compress: true,
    listMode: "list",
    day: "2026-10-28",
    dayActivity: null,
    daySelected: null,
  });
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

  it("opens a family on a focused member's own tip", async () => {
    const fam = detail("P", withRoot.nodes, [member("P", null), { ...member("F", "P"), tipId: "p-a1" }]);
    api.getSession.mockResolvedValueOnce(fam);
    await useStore.getState().openSession("P", { focus: "F" });
    expect(useStore.getState().selected).toBe("p-a1");
    // Not the tip, so a live update doesn't drag the selection away.
    expect(useStore.getState().following).toBe(false);
    api.getSession.mockResolvedValueOnce(fam);
    await useStore.getState().openSession("P");
    expect(useStore.getState().selected).toBe("f-u2");
  });

  it("restores remembered view state at launch, and saves it again when it changes", async () => {
    const remembered = settingsState(true, { compress: false, cwdFilter: "c:/work", providerFilter: "codex", mode: "day" });
    api.getSettings.mockResolvedValueOnce(remembered);
    api.setSettings.mockResolvedValue(remembered);
    vi.useFakeTimers();
    try {
      await useStore.getState().boot();
      expect(useStore.getState()).toMatchObject({
        compress: false,
        cwdFilter: "c:/work",
        providerFilter: "codex",
        listMode: "day",
      });
      useStore.getState().set({ providerFilter: "" });
      await vi.advanceTimersByTimeAsync(600);
      expect(api.setSettings).toHaveBeenCalledWith({
        view: { compress: false, cwdFilter: "c:/work", providerFilter: "", mode: "day" },
      });
      // Switching back to the list is remembered too.
      api.setSettings.mockClear();
      useStore.getState().set({ listMode: "list" });
      await vi.advanceTimersByTimeAsync(600);
      expect(api.setSettings).toHaveBeenCalledWith({
        view: { compress: false, cwdFilter: "c:/work", providerFilter: "", mode: "list" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes no remembered view once remembering is turned off, even one already scheduled", async () => {
    api.getSettings.mockResolvedValueOnce(settingsState(true, { compress: true, cwdFilter: "", providerFilter: "" }));
    api.setSettings.mockImplementation(async (patch: { rememberView?: boolean }) =>
      settingsState(patch.rememberView ?? true),
    );
    vi.useFakeTimers();
    try {
      await useStore.getState().boot();
      await vi.advanceTimersByTimeAsync(600);
      api.setSettings.mockClear();
      // A filter change schedules a save; remembering is turned off before it fires.
      useStore.getState().set({ providerFilter: "claude" });
      await useStore.getState().saveSettings({ rememberView: false, view: null });
      await vi.advanceTimersByTimeAsync(600);
      expect(api.setSettings.mock.calls).toEqual([[{ rememberView: false, view: null }]]);
      // And nothing is scheduled by later changes either.
      useStore.getState().set({ providerFilter: "codex" });
      await vi.advanceTimersByTimeAsync(600);
      expect(api.setSettings).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      api.setSettings.mockReset();
    }
  });

  it("keeps the newest settings when an older write answers last", async () => {
    let answerOld!: (s: SettingsState) => void;
    api.setSettings.mockReturnValueOnce(new Promise((r) => (answerOld = r)));
    api.setSettings.mockResolvedValueOnce(settingsState(false));
    const older = useStore.getState().saveSettings({ sortBy: "touched" });
    await useStore.getState().saveSettings({ rememberView: false, view: null });
    answerOld(settingsState(true));
    await older;
    expect(useStore.getState().settings?.settings.rememberView).toBe(false);
  });

  it("acts on a focused quiet fork over the history it shares with its parent", async () => {
    api.getSession.mockResolvedValue(quiet);
    await useStore.getState().openSession("P", { focus: "F" });
    expect(useStore.getState()).toMatchObject({ selected: "p-a1", focus: "F" });
    // The node is drawn as P's; open/resume still go to the fork.
    expect(target()).toEqual({ provider: "claude", sessionId: "F", cwd: "/work/F" });
    // A turn the fork doesn't hold acts on its own session...
    useStore.getState().select("p-a2");
    expect(target().sessionId).toBe("P");
    // ...and coming back to shared history is the fork again, across a reload too.
    useStore.getState().select("p-u1");
    await useStore.getState().reloadSession();
    expect(useStore.getState().focus).toBe("F");
    expect(target().sessionId).toBe("F");
  });

  it("acts on the parent when the family is opened on it, and drops a focus that left the family", async () => {
    api.getSession.mockResolvedValue(quiet);
    await useStore.getState().openSession("P");
    expect(useStore.getState().focus).toBeNull();
    expect(target().sessionId).toBe("P");
    useStore.getState().select("p-a1");
    expect(target().sessionId).toBe("P");

    await useStore.getState().openSession("P", { focus: "F" });
    api.getSession.mockResolvedValue({ ...quiet, members: [member("P", null)] });
    await useStore.getState().reloadSession();
    expect(useStore.getState().focus).toBeNull();
    expect(target().sessionId).toBe("P");
  });

  describe("a family split by deleting the member that bridged it", () => {
    // P — B — F, where only B shares history with both. B is deleted: P and F
    // each still load, as separate families.
    const whole = detail(
      "P",
      [
        node("p-u1", null, "Q", "u:q", "P", ["P", "B", "F"]),
        node("p-a1", "p-u1", "A", "m:a", "P", ["P", "B"]),
        node("b-a1", "p-u1", "R", "m:r", "B", ["B", "F"]),
        node("f-u2", "b-a1", "Nightly", "u:n", "F", ["F"]),
        node("f-a2", "f-u2", "Cron", "m:c", "F", ["F"]),
      ],
      [member("P", null), member("B", "P"), { ...member("F", "B"), tipId: "f-a2" }],
    );
    const pAlone = detail("P", [node("p-u1", null, "Q", "u:q", "P"), node("p-a1", "p-u1", "A", "m:a", "P")], [member("P", null)]);
    const fAlone = detail(
      "F",
      [
        node("f-u1", null, "Q", "u:q", "F"),
        node("f-a1", "f-u1", "R", "m:r", "F"),
        node("f-u2", "f-a1", "Nightly", "u:n", "F"),
        node("f-a2", "f-u2", "Cron", "m:c", "F"),
      ],
      [member("F", null)],
    );
    const split = async (id: string) => (id === "P" ? pAlone : id === "F" ? fAlone : null);

    it("keeps the user on the focused fork's side", async () => {
      api.getSession.mockResolvedValueOnce(whole);
      await useStore.getState().openSession("P", { focus: "F" });
      useStore.getState().select("f-u2");
      api.getSession.mockImplementation(split);
      await useStore.getState().reloadSession();
      expect(useStore.getState()).toMatchObject({ focus: "F", selected: "f-u2" });
      expect(useStore.getState().session?.meta.id).toBe("F");
    });

    it("keeps the user on the selected turn's side when no fork is focused", async () => {
      api.getSession.mockResolvedValueOnce(whole);
      await useStore.getState().openSession("P");
      useStore.getState().select("b-a1");
      api.getSession.mockImplementation(split);
      await useStore.getState().reloadSession();
      expect(useStore.getState().session?.meta.id).toBe("F");
      expect(useStore.getState().selected).toBe("f-a1");
    });
  });

  it("keeps a selection's end when new membership splits its node under the same head", async () => {
    // P's reply drawn as one node, "A" then "B", ending on p-a2; a later turn makes it history.
    const grouped = detail(
      "P",
      [
        node("p-u1", null, "Q", "u:q", "P"),
        { ...node("p-a1", "p-u1", "A\n\nB", "m:a", "P"), lastRawId: "p-a2", stableIds: ["m:a", "m:b"] },
        node("p-u2", "p-a1", "Q2", "u:q2", "P"),
      ],
      [member("P", null)],
    );
    // A quiet fork holding only "A" appears: same head id, now ending on A.
    const split = detail(
      "P",
      [
        node("p-u1", null, "Q", "u:q", "P", ["P", "F"]),
        node("p-a1", "p-u1", "A", "m:a", "P", ["P", "F"]),
        node("p-a2", "p-a1", "B", "m:b", "P"),
        node("p-u2", "p-a2", "Q2", "u:q2", "P"),
      ],
      [member("P", null), member("F", "P")],
    );
    api.getSession.mockResolvedValueOnce(grouped);
    await useStore.getState().openSession("P");
    useStore.getState().select("p-a1");
    api.getSession.mockResolvedValueOnce(split);
    await useStore.getState().reloadSession();
    // Still the prefix through B, not the shorter one through A.
    expect(useStore.getState().selected).toBe("p-a2");
  });

  it("a member chosen while a reload is reading the stores outranks the one the reload asked for", async () => {
    // F and G share the opening turn; their root went away, so they now load apart.
    const whole = detail(
      "F",
      [node("f-u1", null, "Q", "u:q", "F", ["F", "G"]), node("f-a1", "f-u1", "A", "m:a", "F"), node("g-a1", "f-u1", "B", "m:b", "G")],
      [member("F", null), member("G", "F")],
    );
    const fAlone = detail("F", [node("f-u1", null, "Q", "u:q", "F"), node("f-a1", "f-u1", "A", "m:a", "F")], [member("F", null)]);
    const gAlone = detail("G", [node("g-u1", null, "Q", "u:q", "G"), node("g-a1", "g-u1", "B", "m:b", "G")], [member("G", null)]);
    api.getSession.mockResolvedValueOnce(whole);
    await useStore.getState().openSession("F", { focus: "F" });
    useStore.getState().select("f-u1");

    let answerF!: (d: SessionDetail) => void;
    api.getSession.mockImplementation((id: string) =>
      id === "F" ? new Promise((r) => (answerF = r)) : Promise.resolve(id === "G" ? gAlone : null),
    );
    const reload = useStore.getState().reloadSession();
    // The user picks G in the member selector before F's lookup answers.
    useStore.getState().set({ focus: "G" });
    answerF(fAlone);
    await reload;
    const s = useStore.getState();
    expect(api.getSession).toHaveBeenCalledWith("G");
    expect(s.session?.meta.id).toBe("G");
    expect(s).toMatchObject({ focus: "G", selected: "g-u1" });
    api.getSession.mockReset();
  });

  it("says an annotation wasn't saved, and redraws what is on disk", async () => {
    api.getSession.mockResolvedValue(withRoot);
    await useStore.getState().openSession("P");
    api.patchNode.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await expect(useStore.getState().setStatus("p-a1", "favorite")).resolves.toBe(false);
    const s = useStore.getState();
    expect(s.annotationError).toMatch(/Not saved: EACCES/);
    expect(s.nodes.get("p-a1")?.status).toBeUndefined();
    // The next annotation that is saved clears the message.
    await expect(useStore.getState().setStatus("p-a1", "favorite")).resolves.toBe(true);
    expect(useStore.getState().annotationError).toBeNull();
    api.getSession.mockReset();
  });

  it("sends a cleared annotation field as null, which survives JSON", async () => {
    api.getSession.mockResolvedValueOnce(withRoot);
    await useStore.getState().openSession("P");
    await useStore.getState().patch("p-a1", { label: undefined });
    expect(api.patchNode).toHaveBeenCalledWith("P", "p-a1", { label: null });
    expect(JSON.parse(JSON.stringify(api.patchNode.mock.calls[0][2]))).toEqual({ label: null });
  });
});

describe("day view state", () => {
  /** Q1 → A1 → Q2 → A2 → Q3 → A3: everything between the root and the leaf collapses into one chain. */
  const linear = detail(
    "P",
    ["u1", "a1", "u2", "a2", "u3", "a3"].map((id, i, all) => ({
      ...node(id, i ? all[i - 1] : null, id, `s:${id}`, "P"),
      role: id.startsWith("u") ? ("user" as const) : ("assistant" as const),
      timestamp: i + 1,
    })),
    [member("P", null)],
  );
  /** A turn as the day view drew it: by where it ended. */
  const drawn = (id: string, endId = id) => ({ point: { nodeId: id, sessionId: "P", endId } });
  const activity = (day: string, ids: string[]): DayActivity => ({
    ...dayBounds(day),
    chats: [],
    running: [],
    turns: ids.map((id) => ({
      id,
      ref: { point: { nodeId: id, sessionId: "P", endId: id } },
      parentId: null,
      sessionId: "P",
      familyId: "P",
      provider: "claude",
      role: "user",
      preview: id,
      timestamp: dayBounds(day).start + 1,
    })),
  });

  it("opens a turn picked in the day view, with the collapsed run hiding it opened", async () => {
    api.getSession.mockResolvedValueOnce(linear);
    await useStore.getState().openSession("P", { focus: "P", select: drawn("u2") });
    const s = useStore.getState();
    expect(s.selected).toBe("u2");
    expect(s.focus).toBe("P");
    expect([...s.expanded]).toEqual(["chain:a1"]);
    // Reading history, not the tip: a live update must not drag it away.
    expect(s.following).toBe(false);
  });

  it("opens a turn picked in the day view on the range it was drawn with, after its group split", async () => {
    // The day view drew P's reply as one node through p-a2; a quiet fork then split it.
    const split = detail(
      "P",
      [
        node("p-u1", null, "Q", "u:q", "P", ["P", "F"]),
        node("p-a1", "p-u1", "A", "m:a", "P", ["P", "F"]),
        node("p-a2", "p-a1", "B", "m:b", "P"),
        node("p-u2", "p-a2", "Q2", "u:q2", "P"),
      ],
      [member("P", null), member("F", "P")],
    );
    api.getSession.mockImplementation(async (id: string) => (id === "P" ? split : null));
    await useStore.getState().openSession("P", {
      focus: "P",
      select: { point: { nodeId: "p-a1", sessionId: "P", endId: "p-a2" }, stableIds: ["m:a", "m:b"] },
    });
    // The end it was drawn with, not the shorter node under the same head.
    expect(useStore.getState().selected).toBe("p-a2");
    api.getSession.mockReset();
  });

  it("asks for the focused chat's family first: the family it was listed in may have split", async () => {
    // The day view drew F's turn in family P; deleting the bridge left F on its own.
    api.getSession.mockImplementation(async (id: string) => (id === "F" ? reRooted : null));
    await useStore.getState().openSession("P", {
      focus: "F",
      select: { point: { nodeId: "f-a1-old", sessionId: "P", endId: "gone" }, stableIds: ["m:a"] },
    });
    expect(api.getSession.mock.calls[0]).toEqual(["F"]);
    // Found again by its semantic identity, under F's own id.
    expect(useStore.getState()).toMatchObject({ selected: "f-a1", focus: "F" });
    expect(useStore.getState().session?.meta.id).toBe("F");
    api.getSession.mockReset();
  });

  it("falls back to the tip when the picked turn is no longer in the family", async () => {
    api.getSession.mockResolvedValueOnce(linear);
    await useStore.getState().openSession("P", { select: drawn("gone") });
    expect(useStore.getState()).toMatchObject({ selected: "a3", following: true });
    expect(useStore.getState().expanded.size).toBe(0);
  });

  it("drops a day's turns that arrive after the user moved to another day, and loads that one", async () => {
    let answerOld!: (a: DayActivity) => void;
    api.getDay.mockReturnValueOnce(new Promise((r) => (answerOld = r)));
    api.getDay.mockResolvedValueOnce(activity("2026-10-27", ["b"]));
    const first = useStore.getState().loadDay();
    useStore.getState().setDay("2026-10-27");
    void useStore.getState().loadDay();
    answerOld(activity("2026-10-28", ["a"]));
    await first;
    const { start, end } = dayBounds("2026-10-27");
    expect(api.getDay).toHaveBeenLastCalledWith(start, end, undefined);
    expect(useStore.getState().dayActivity?.turns.map((t) => t.id)).toEqual(["b"]);
  });

  /** What the worker answers for a want: `found`, as `dayActivity` would. */
  const withFound = (a: DayActivity, found: DayFound | null): DayActivity => ({ ...a, found });
  const foundAt = (id: string, timestamp: number, familyId = "P"): DayFound => ({
    familyId,
    id,
    timestamp,
    ref: { point: { nodeId: id, sessionId: familyId, endId: id } },
  });

  it("keeps the day selection across a refresh while the worker finds it in the day", async () => {
    const day = activity("2026-10-28", ["a", "b"]);
    const at = day.turns[1].timestamp;
    api.getDay.mockResolvedValueOnce(day);
    await useStore.getState().loadDay();
    useStore.getState().set({ daySelected: "claude:P:b" });
    api.getDay.mockResolvedValueOnce(withFound(activity("2026-10-28", ["a", "b", "c"]), foundAt("b", at)));
    await useStore.getState().loadDay();
    expect(useStore.getState().daySelected).toBe("claude:P:b");
    // Asked for by the turn as drawn, through the sessions that hold it.
    const want = api.getDay.mock.calls[1][2] as DayWant;
    expect(want).toEqual({ provider: "claude", sessions: ["P"], ref: day.turns[1].ref });
    api.getDay.mockResolvedValueOnce(withFound(activity("2026-10-28", ["a"]), null));
    await useStore.getState().loadDay();
    expect(useStore.getState().daySelected).toBeNull();
  });

  it("follows the selection to wherever the worker found it in its family, or lets it go", async () => {
    const base = dayBounds("2026-10-28").start;
    const turn = (id: string, family: string, heldBy?: string[]): DayTurn => ({
      id,
      ref: { point: { nodeId: id, sessionId: family, endId: id }, stableIds: [`m:${id}`] },
      parentId: null,
      sessionId: family,
      ...(heldBy ? { heldBy } : {}),
      familyId: family,
      provider: "claude",
      role: "assistant",
      preview: id,
      timestamp: base + 1,
    });
    const day = (turns: DayTurn[]): DayActivity => ({ ...dayBounds("2026-10-28"), chats: [], running: [], turns });
    api.getDay.mockResolvedValueOnce(day([turn("p-a1", "P", ["F"])]));
    await useStore.getState().loadDay();
    useStore.getState().set({ daySelected: "claude:P:p-a1" });

    // P deleted: F, re-rooted, draws it under its own id. The worker looked
    // in P's family through F, the other session holding the turn.
    api.getDay.mockResolvedValueOnce(withFound(day([turn("f-a1", "F"), turn("x-a1", "X")]), foundAt("f-a1", base + 1, "F")));
    await useStore.getState().loadDay();
    expect((api.getDay.mock.calls[1][2] as DayWant).sessions).toEqual(["P", "F"]);
    expect(useStore.getState().daySelected).toBe("claude:F:f-a1");

    // Its end now starts on the next day (a group split at midnight): the
    // refresh deselects it rather than keep a shorter range, and stays here.
    api.getDay.mockResolvedValueOnce(withFound(day([turn("f-a1", "F")]), foundAt("f-a2", dayBounds("2026-10-29").start + 5, "F")));
    await useStore.getState().loadDay();
    expect(useStore.getState()).toMatchObject({ day: "2026-10-28", daySelected: null });
  });

  it("asks again for a turn picked while a refresh was out, by its drawn end, before adopting anything", async () => {
    const base = dayBounds("2026-10-28").start;
    const t = (id: string, endId = id): DayTurn => ({
      id,
      ref: { point: { nodeId: id, sessionId: "P", endId } },
      parentId: null,
      sessionId: "P",
      familyId: "P",
      provider: "claude",
      role: "assistant",
      preview: id,
      timestamp: base + 1,
    });
    const day = (turns: DayTurn[]): DayActivity => ({ ...dayBounds("2026-10-28"), chats: [], running: [], turns });
    // A, and B drawn as one node through b2.
    api.getDay.mockResolvedValueOnce(day([t("a"), t("b", "b2")]));
    await useStore.getState().loadDay();
    useStore.getState().set({ daySelected: "claude:P:a" });
    let answer!: (a: DayActivity) => void;
    api.getDay.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const refresh = useStore.getState().loadDay();
    // B is picked in the snapshot on screen while the refresh asks about A.
    useStore.getState().set({ daySelected: "claude:P:b" });
    // A quiet fork split B: b now ends on itself, b2 is a node of its own.
    const split = day([t("a"), t("b"), t("b2")]);
    api.getDay.mockResolvedValueOnce(withFound(split, foundAt("b2", base + 1)));
    answer(withFound(split, foundAt("a", base + 1)));
    await refresh;
    // The answer about A wasn't adopted; B was asked for as drawn, through b2.
    expect((api.getDay.mock.calls[2][2] as DayWant).ref).toEqual(t("b", "b2").ref);
    expect(useStore.getState().daySelected).toBe("claude:P:b2");
  });

  it("lets a newer request move to the day its turn started, though the older one had moved already", async () => {
    // A asked for on Oct 3 starts on Oct 2; B, asked for on Oct 2 while A
    // reloads there, started on Oct 1.
    const want = (s: string): DayWant => ({ provider: "claude", sessions: [s] });
    const oct1 = activity("2026-10-01", ["b1"]);
    const at2 = activity("2026-10-02", ["a1"]).turns[0].timestamp;
    const b1 = foundAt("b1", oct1.turns[0].timestamp);
    api.getDay.mockResolvedValueOnce(withFound(activity("2026-10-03", []), foundAt("a1", at2)));
    let answerA!: (a: DayActivity) => void;
    api.getDay.mockReturnValueOnce(new Promise((r) => (answerA = r)));
    api.getDay.mockResolvedValueOnce(withFound(activity("2026-10-02", []), b1));
    api.getDay.mockResolvedValueOnce(withFound(oct1, b1));
    api.getDay.mockResolvedValueOnce(withFound(oct1, b1));
    const a = useStore.getState().showInDay("2026-10-03", want("A"));
    await vi.waitFor(() => expect(api.getDay).toHaveBeenCalledTimes(2));
    useStore.getState().set({ listMode: "list" });
    const b = useStore.getState().showInDay("2026-10-02", want("B"));
    answerA(withFound(activity("2026-10-02", ["a1"]), foundAt("a1", at2)));
    await Promise.all([a, b]);
    const asked = api.getDay.mock.calls.map((c) => [dayKeyOf(c[0] as number), (c[2] as DayWant).sessions[0]]);
    expect(asked.slice(0, 4)).toEqual([["2026-10-03", "A"], ["2026-10-02", "P"], ["2026-10-02", "B"], ["2026-10-01", "P"]]);
    expect(useStore.getState()).toMatchObject({ day: "2026-10-01", daySelected: "claude:P:b1", dayTarget: null, error: null });
  });

  it("lets a newer request for the same day stand over an older one's answer", async () => {
    const want = (s: string): DayWant => ({ provider: "claude", sessions: [s] });
    let answerA!: (a: DayActivity) => void;
    api.getDay.mockReturnValueOnce(new Promise((r) => (answerA = r)));
    const a = useStore.getState().showInDay("2026-10-28", want("A"));
    // Back to the list, and B's day button, while A's day is loading.
    useStore.getState().set({ listMode: "list" });
    const b = useStore.getState().showInDay("2026-10-28", want("B"));
    const bDay = activity("2026-10-28", ["b1"]);
    api.getDay.mockResolvedValueOnce(withFound(bDay, foundAt("b1", bDay.turns[0].timestamp)));
    // The pass B's request queued behind A's: an ordinary refresh of B's turn.
    api.getDay.mockResolvedValueOnce(withFound(bDay, foundAt("b1", bDay.turns[0].timestamp)));
    answerA(withFound(activity("2026-10-28", ["a1"]), foundAt("a1", bDay.turns[0].timestamp)));
    await Promise.all([a, b]);
    // A's answer wasn't adopted: B was asked for next, and is what's selected.
    expect(api.getDay.mock.calls.map((c) => (c[2] as DayWant | undefined)?.sessions)).toEqual([["A"], ["B"], ["P"]]);
    expect(useStore.getState()).toMatchObject({ daySelected: "claude:P:b1", dayTarget: null, error: null });
  });

  it("shows a tree's selected turn in its day: the tree closes and the turn is picked as it was drawn", async () => {
    api.getSession.mockResolvedValueOnce(linear);
    await useStore.getState().openSession("P", { select: drawn("u2") });
    useStore.getState().set({ dayViewport: { day: "2026-10-05", tx: 1, ty: 2, k: 3 }, cwdFilter: "c:/elsewhere" });
    const day = activity("2026-10-05", ["u1", "u2", "a2"]);
    api.getDay.mockResolvedValueOnce(withFound(day, foundAt("u2", day.turns[1].timestamp)));
    const want: DayWant = { provider: "claude", sessions: ["P"], ref: drawn("u2") };
    await useStore.getState().showInDay("2026-10-05", want);
    const s = useStore.getState();
    expect(s.session).toBeNull();
    expect(s).toMatchObject({ listMode: "day", day: "2026-10-05", daySelected: "claude:P:u2", dayViewport: null, dayTarget: null });
    expect(api.getDay).toHaveBeenLastCalledWith(dayBounds("2026-10-05").start, dayBounds("2026-10-05").end, want);
    // Its lane was outside the directory filter: the filters give way to the chat asked for.
    expect(s.cwdFilter).toBe("");
  });

  it("shows a conversation on the day its latest turn started, when that was the day before", async () => {
    // Its last activity was after midnight, in a turn that started before.
    const late = activity("2026-10-05", ["late"]);
    api.getDay.mockResolvedValueOnce(withFound(activity("2026-10-06", []), foundAt("late", late.turns[0].timestamp)));
    api.getDay.mockResolvedValueOnce(withFound(late, foundAt("late", late.turns[0].timestamp)));
    await useStore.getState().showInDay("2026-10-06", { provider: "claude", sessions: ["P", "F"] });
    expect(useStore.getState()).toMatchObject({ day: "2026-10-05", daySelected: "claude:P:late", dayTarget: null });
    const [, , again] = api.getDay.mock.calls[1];
    expect(api.getDay.mock.calls[1].slice(0, 2)).toEqual([dayBounds("2026-10-05").start, dayBounds("2026-10-05").end]);
    // Asked for again as found, so the second day can't land on another turn.
    expect(again).toMatchObject({ provider: "claude", sessions: ["P", "F"], ref: foundAt("late", 0).ref });
  });

  it("drops a day target once the user has moved to another day", async () => {
    let answer!: (a: DayActivity) => void;
    api.getDay.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const shown = useStore.getState().showInDay("2026-10-05", { provider: "claude", sessions: ["P"] });
    useStore.getState().setDay("2026-10-06");
    answer(activity("2026-10-05", ["u1"]));
    await shown;
    expect(useStore.getState()).toMatchObject({ day: "2026-10-06", daySelected: null, dayTarget: null });
  });

  it("comes back to the same day and turn when the tree is closed", async () => {
    useStore.getState().set({ listMode: "day", day: "2026-10-01", daySelected: "claude:P:u2" });
    api.getSession.mockResolvedValueOnce(linear);
    await useStore.getState().openSession("P", { select: drawn("u2") });
    useStore.getState().close();
    expect(useStore.getState()).toMatchObject({ listMode: "day", day: "2026-10-01", daySelected: "claude:P:u2" });
  });

  it("forgets the old day's turns as soon as another day is picked", () => {
    useStore.getState().set({ dayActivity: activity("2026-10-28", ["a"]), daySelected: "claude:P:a" });
    useStore.getState().setDay("2026-10-29");
    expect(useStore.getState()).toMatchObject({ day: "2026-10-29", dayActivity: null, daySelected: null });
  });
});
