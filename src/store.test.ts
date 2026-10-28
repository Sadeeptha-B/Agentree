// Lives in src/ (not test/) so it type-checks with the renderer's DOM config.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DayActivity, MemberInfo, SessionDetail, SettingsState, TurnNode } from "../shared/types.ts";
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
const { dayBounds } = await import("./day.ts");

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
  const activity = (day: string, ids: string[]): DayActivity => ({
    ...dayBounds(day),
    chats: [],
    turns: ids.map((id) => ({
      id,
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
    await useStore.getState().openSession("P", { focus: "P", select: "u2" });
    const s = useStore.getState();
    expect(s.selected).toBe("u2");
    expect(s.focus).toBe("P");
    expect([...s.expanded]).toEqual(["chain:a1"]);
    // Reading history, not the tip: a live update must not drag it away.
    expect(s.following).toBe(false);
  });

  it("falls back to the tip when the picked turn is no longer in the family", async () => {
    api.getSession.mockResolvedValueOnce(linear);
    await useStore.getState().openSession("P", { select: "gone" });
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
    expect(api.getDay).toHaveBeenLastCalledWith(start, end);
    expect(useStore.getState().dayActivity?.turns.map((t) => t.id)).toEqual(["b"]);
  });

  it("keeps the day selection across a refresh while the turn is still there", async () => {
    api.getDay.mockResolvedValueOnce(activity("2026-10-28", ["a", "b"]));
    await useStore.getState().loadDay();
    useStore.getState().set({ daySelected: "claude:P:b" });
    api.getDay.mockResolvedValueOnce(activity("2026-10-28", ["a", "b", "c"]));
    await useStore.getState().loadDay();
    expect(useStore.getState().daySelected).toBe("claude:P:b");
    api.getDay.mockResolvedValueOnce(activity("2026-10-28", ["a"]));
    await useStore.getState().loadDay();
    expect(useStore.getState().daySelected).toBeNull();
  });

  it("comes back to the same day and turn when the tree is closed", async () => {
    useStore.getState().set({ listMode: "day", day: "2026-10-01", daySelected: "claude:P:u2" });
    api.getSession.mockResolvedValueOnce(linear);
    await useStore.getState().openSession("P", { select: "u2" });
    useStore.getState().close();
    expect(useStore.getState()).toMatchObject({ listMode: "day", day: "2026-10-01", daySelected: "claude:P:u2" });
  });

  it("forgets the old day's turns as soon as another day is picked", () => {
    useStore.getState().set({ dayActivity: activity("2026-10-28", ["a"]), daySelected: "claude:P:a" });
    useStore.getState().setDay("2026-10-29");
    expect(useStore.getState()).toMatchObject({ day: "2026-10-29", dayActivity: null, daySelected: null });
  });
});
