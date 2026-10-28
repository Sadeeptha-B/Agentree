// Lives in src/ (not test/) so it type-checks with the renderer's DOM config.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateCreator } from "zustand";
import type { DayActivity, SessionMeta, SettingsState } from "../shared/types.ts";

const api = vi.hoisted(() => ({
  host: "vscode",
  listSessions: vi.fn(async () => []),
  getDay: vi.fn(),
  providerHealth: vi.fn(async () => []),
  setSettings: vi.fn(),
}));
vi.mock("./api.ts", () => ({ api }));
// A server render reads a zustand store's INITIAL state; this hook renders
// the live one, so markup can be checked without a DOM.
vi.mock("zustand", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { useSyncExternalStore } = await import("react");
  return {
    create: <T,>(init: StateCreator<T>) => {
      const store = createStore<T>(init);
      const read = () => store.getState();
      return Object.assign(() => useSyncExternalStore(store.subscribe, read, read), store);
    },
  };
});

const { useStore } = await import("./store.ts");
const { Welcome } = await import("./components/Welcome.tsx");

const state: SettingsState = {
  settings: {
    sortBy: "active",
    providers: { claude: true, codex: true, copilot: true },
    showArchivedCodex: false,
    rememberView: false,
    paths: {},
    updateCheck: true,
  },
  env: {},
  updateCheckDisabledByEnv: false,
  file: "settings.json",
};

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ settings: state, settingsError: null, error: null, settingsOpen: true, listMode: "list" });
});

describe("welcome screen and settings", () => {
  it("say a settings change wasn't saved, and stop saying so once a retry is", async () => {
    api.setSettings.mockRejectedValueOnce(new Error("EACCES: settings.json is read-only"));
    expect(await useStore.getState().saveSettings({ sortBy: "touched" })).toBe(false);
    expect(renderToStaticMarkup(<Welcome />)).toContain("Not saved: EACCES: settings.json is read-only");
    // The dialog closed, the welcome screen still says so.
    useStore.setState({ settingsOpen: false });
    expect(renderToStaticMarkup(<Welcome />)).toContain("Settings not saved: EACCES");

    api.setSettings.mockResolvedValueOnce(state);
    expect(await useStore.getState().saveSettings({ sortBy: "touched" })).toBe(true);
    expect(renderToStaticMarkup(<Welcome />)).not.toContain("not saved");
  });

  it("shows the list's own failures", () => {
    useStore.setState({ settingsOpen: false, error: "Error: worker exited" });
    expect(renderToStaticMarkup(<Welcome />)).toContain("Error: worker exited");
  });
});

describe("day view", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const F = "22222222-2222-4222-8222-222222222222";
  const start = new Date(2026, 9, 28).getTime();
  const activity: DayActivity = {
    start,
    end: new Date(2026, 9, 29).getTime(),
    running: [],
    chats: [
      { provider: "claude", familyId: P, sessionId: P, title: "Build walkthrough", familyTitle: "Build walkthrough", cwd: "/work", parentSessionId: null },
      { provider: "claude", familyId: P, sessionId: F, title: "Try rollup", familyTitle: "Build walkthrough", cwd: "/work", parentSessionId: P },
    ],
    turns: [
      { id: "u1", ref: { point: { nodeId: "u1", sessionId: P, endId: "u1" } }, parentId: null, sessionId: P, familyId: P, provider: "claude", role: "user", preview: "Explain the build", timestamp: start + 3_600_000 },
      { id: "f1", ref: { point: { nodeId: "f1", sessionId: F, endId: "f1" } }, parentId: "u1", sessionId: F, familyId: P, provider: "claude", role: "user", preview: "Try rollup instead", timestamp: start + 7_200_000, branchKind: "fork" },
    ],
  };

  it("switches the welcome pane between the list and the day", () => {
    useStore.setState({ settingsOpen: false });
    const list = renderToStaticMarkup(<Welcome />);
    expect(list).toContain("tree-list");
    expect(list).toContain("sort-toggle");
    expect(list).not.toContain("day-head");

    useStore.setState({ listMode: "day", day: "2026-10-28", dayActivity: activity, daySelected: null });
    const day = renderToStaticMarkup(<Welcome />);
    expect(day).not.toContain("tree-list");
    expect(day).not.toContain("sort-toggle");
    expect(day).toContain("day-head");
    // Both chats, the fork marked, in the lanes and in the side card.
    expect(day).toContain("Chats this day");
    expect(day).toContain("Try rollup");
    expect((day.match(/class="day-dot /g) ?? []).length).toBe(2);
    expect(day).toContain("edge cross");
  });

  it("puts each chat's repository in the day's chat list, and a way into its day on each list card", () => {
    useStore.setState({ settingsOpen: false, listMode: "day", day: "2026-10-28", dayActivity: activity, daySelected: null });
    expect(renderToStaticMarkup(<Welcome />)).toContain('<code class="path day-chat-path">/work</code>');
    // With a directory picked, every chat shown is in it: no path to repeat.
    useStore.setState({ cwdFilter: "/work" });
    expect(renderToStaticMarkup(<Welcome />)).not.toContain("day-chat-path");
    useStore.setState({ cwdFilter: "" });
    const card = { id: P, provider: "claude", cwd: "/work", project: "work", title: "Build", activeAt: start + 3_600_000, touchedAt: start + 3_600_000, nodeCount: 2, branchPoints: 0, resumeCommand: "" } as SessionMeta;
    useStore.setState({ listMode: "list", sessions: [card] });
    const list = renderToStaticMarkup(<Welcome />);
    expect(list).toContain("card-day");
    expect(list).toContain("Show this conversation in the day view of");
  });

  it("shows the selected turn with the way into its tree", () => {
    useStore.setState({ settingsOpen: false, listMode: "day", day: "2026-10-28", dayActivity: activity, daySelected: `claude:${P}:f1` });
    const html = renderToStaticMarkup(<Welcome />);
    expect(html).toContain("Try rollup instead");
    expect(html).toContain("open in tree");
    expect(html).toContain("starts the fork");
  });

  it("offers the latest active day when the shown one is empty", () => {
    const latest = { activeAt: new Date(2026, 9, 20, 15).getTime() } as SessionMeta;
    useStore.setState({
      settingsOpen: false,
      listMode: "day",
      day: "2026-10-28",
      sessions: [latest],
      dayActivity: { start, end: start + 1, chats: [], turns: [], running: [] },
    });
    const html = renderToStaticMarkup(<Welcome />);
    expect(html).toContain("No activity on");
    expect(html).toContain("go to the latest activity");
  });
});
