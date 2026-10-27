import { create } from "zustand";
import { api } from "./api.ts";
import { childIndex, newestLeaf, toNodeMap, type NodeMap } from "../shared/render.ts";
import type {
  NodeId,
  NodeMeta,
  NodeStatus,
  ProviderHealth,
  ProviderId,
  SessionDetail,
  SessionMeta,
  TurnNode,
  UpdateInfo,
} from "../shared/types.ts";

interface State {
  sessions: SessionMeta[];
  /** One row per provider from the last scan — shown above the list. */
  health: ProviderHealth[];
  filter: string;
  /** Show only sessions from this working directory (a `cwdKey`). Empty means all of them. */
  cwdFilter: string;
  /** Show only one agent's sessions. Empty means every agent. */
  providerFilter: ProviderId | "";

  session: SessionDetail | null;
  nodes: NodeMap;
  children: Map<string, TurnNode[]>;

  selected: NodeId | null;
  /** Collapsed linear runs the user has clicked open. */
  expanded: Set<string>;
  compress: boolean;

  error: string | null;
  loading: boolean;
  /** Set once per launch if the main process found a newer build on GitHub. */
  update: UpdateInfo | null;

  boot: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  close: () => void;

  select: (id: NodeId | null) => void;
  toggleChain: (chainId: string) => void;

  /** Re-read the open session from disk, keeping the user's place. */
  reloadSession: () => Promise<void>;
  /** True while the selection sits on the conversation tip, so it can follow. */
  following: boolean;

  patch: (id: NodeId, patch: Partial<TurnNode>) => Promise<void>;
  setStatus: (id: NodeId, status: NodeStatus | undefined) => Promise<void>;

  set: (partial: Partial<State>) => void;
}

/**
 * Back-pressure for disk-driven refreshes.
 *
 * A full session scan takes far longer than the watcher's debounce, so during
 * an active conversation changes arrive faster than they can be served. Without
 * a gate each one starts another parse, and every pending IPC promise retains a
 * whole parse result — the renderer grows without bound until the process dies.
 *
 * So: at most one refresh of a kind in flight. Anything that arrives while one
 * is running sets `again`, which triggers exactly one more pass afterwards —
 * never a queue, but never a missed update either.
 */
function gate(): (run: () => Promise<void>) => Promise<void> {
  let busy = false;
  let again = false;
  return async function invoke(run) {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      await invoke(run);
    }
  };
}

const listGate = gate();
const sessionGate = gate();

/**
 * Which open view an async result belongs to. Bumped by every open and close;
 * a result that comes back for an older view is dropped. Without it, a
 * reload in flight when the user closed the conversation re-opened it.
 */
let view = 0;

/** Where a node lives under a re-rooted family: same id, else same semantic identity. */
function carry(id: NodeId | null, from: NodeMap, to: NodeMap): NodeId | null {
  if (!id) return null;
  if (to.has(id)) return id;
  const ids = new Set(from.get(id)?.stableIds ?? []);
  if (!ids.size) return null;
  for (const n of to.values()) if (n.stableIds?.some((s) => ids.has(s))) return n.id;
  return null;
}

export const useStore = create<State>((set, get) => ({
  sessions: [],
  health: [],
  filter: "",
  cwdFilter: "",
  providerFilter: "",

  session: null,
  nodes: new Map(),
  children: new Map(),

  selected: null,
  expanded: new Set(),
  compress: true,
  following: true,

  error: null,
  loading: false,
  update: null,

  set: (partial) => set(partial),

  boot: async () => {
    api.onUpdateAvailable((update) => set({ update }));
    await get().refreshSessions();
  },

  refreshSessions: () =>
    listGate(async () => {
      set({ loading: true });
      try {
        set({ sessions: await api.listSessions() });
        // After the list: health describes the scan that list came from.
        set({ health: await api.providerHealth() });
      } catch (e) {
        set({ error: String(e) });
      } finally {
        set({ loading: false });
      }
    }),

  openSession: async (id) => {
    const mine = ++view;
    set({ loading: true });
    try {
      const session = await api.getSession(id);
      if (mine !== view) return;
      if (!session) {
        set({ error: "That session's transcript is no longer on disk." });
        return;
      }
      const nodes = toNodeMap(session.nodes);
      const children = childIndex(session.nodes);
      set({
        session,
        nodes,
        children,
        selected: newestLeaf(session.nodes, children),
        expanded: new Set(),
        following: true,
        error: null,
      });
    } catch (e) {
      if (mine === view) set({ error: String(e) });
    } finally {
      if (mine === view) set({ loading: false });
    }
  },

  close: () => {
    view++;
    set({
      session: null,
      nodes: new Map(),
      children: new Map(),
      selected: null,
      expanded: new Set(),
      error: null,
    });
    // The list may have changed while the tree was open (a fork made, a
    // member deleted); the welcome watch only fires on the NEXT write.
    void get().refreshSessions();
  },

  // Clicking a node stops the view chasing the tip; clicking the tip resumes it.
  select: (id) =>
    set({
      selected: id,
      following: id != null && id === newestLeaf(get().session?.nodes ?? [], get().children),
    }),

  reloadSession: () =>
    sessionGate(async () => {
      const mine = view;
      const prev = get().session;
      if (!prev) return;

      // A family isn't one file: its root can be deleted while a fork
      // survives, and the provider then re-roots the family on that fork. So
      // the view asks for its root, then for the selected turn's session, then
      // for any other member it knew — the first that loads is the family now.
      const prevNodes = get().nodes;
      const selectedSource = get().selected ? prevNodes.get(get().selected!)?.sourceSessionId : undefined;
      const candidates = [
        ...new Set([prev.meta.id, selectedSource, ...prev.members.map((m) => m.id)].filter(Boolean) as string[]),
      ];
      let session = null;
      for (const id of candidates) {
        session = await api.getSession(id);
        if (mine !== view) return;
        if (session) break;
      }
      if (!session) {
        set({ error: "This conversation's transcripts are no longer on disk." });
        return;
      }

      const nodes = toNodeMap(session.nodes);
      const children = childIndex(session.nodes);
      const tip = newestLeaf(session.nodes, children);

      // Follow the conversation only if the user was already sitting on the
      // tip. Otherwise they're reading history, and yanking the selection away
      // as new turns land would make the app unusable during a live session.
      // A re-rooted family draws shared turns under another session's ids;
      // the selection follows its semantic identity there.
      const wasFollowing = get().following;
      const kept = carry(get().selected, prevNodes, nodes);
      const selected = wasFollowing || !kept ? tip : kept;

      // `expanded` is intentionally preserved: chain ids are keyed on their
      // first node, so an opened run stays open as turns are appended below it.
      set({ session, nodes, children, selected, error: null });
    }),

  toggleChain: (chainId) => {
    const next = new Set(get().expanded);
    if (next.has(chainId)) next.delete(chainId);
    else next.add(chainId);
    set({ expanded: next });
  },

  patch: async (id, patch) => {
    const { session } = get();
    if (!session) return;
    const nodes = session.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
    set({
      session: { ...session, nodes },
      nodes: toNodeMap(nodes),
      children: childIndex(nodes),
    });
    // A cleared field travels as null: `undefined` doesn't survive JSON (the
    // VS Code webview bridge), and a dropped key would mean "leave as is".
    const wire = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null])) as NodeMeta;
    await api.patchNode(session.meta.id, id, wire);
  },

  setStatus: async (id, status) => {
    await get().patch(id, { status });
  },
}));
