import type { NodeMeta, SessionId } from "../shared/types.ts";
import { allHealth, annotate, forkAnyAt, listAllSessions, loadAnySession, watchTargets } from "./registry.ts";

/**
 * Everything that touches the transcript stores, as one table of calls.
 *
 * It runs in a worker thread (`worker.ts`), never on the host's own thread:
 * a cold scan decompresses every Codex page and parses every Claude
 * transcript — ~2.6 s on the target machine — and the host thread is VS Code's
 * extension host (every extension stalls with it) or Electron's main process
 * (the window stops repainting). The worker keeps the parse caches, so a warm
 * call is as cheap as before; only the hop is new.
 *
 * Hosts reach it through `backend-client.ts`, which imports this file's TYPE
 * only — the providers are bundled into the worker, not into the host.
 */
export const methods = {
  listSessions: () => listAllSessions(),
  getSession: (id: SessionId) => loadAnySession(id),
  patchNode: (familyId: SessionId, nodeId: string, patch: NodeMeta) => annotate(familyId, nodeId, patch),
  forkAt: (sessionId: SessionId, nodeId: string) => forkAnyAt(sessionId, nodeId),
  providerHealth: () => allHealth(),
  watchTargets: (sessionId: SessionId | null) => watchTargets(sessionId),
};

export type Methods = typeof methods;
export type MethodName = keyof Methods;
