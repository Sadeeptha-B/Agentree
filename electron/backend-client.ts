import { Worker } from "node:worker_threads";
import type { MethodName, Methods } from "./backend.ts";

/** Each backend call, as the host sees it: same arguments, always async. */
export type Backend = {
  [K in MethodName]: (...args: Parameters<Methods[K]>) => Promise<Awaited<ReturnType<Methods[K]>>>;
} & { dispose(): void };

/**
 * The host's handle on the backend worker (`worker.cjs`, built next to the
 * host bundle). The worker is started on first use and restarted on the next
 * call if it ever dies; a crash fails the calls in flight with its error
 * instead of leaving them hanging.
 */
export function startBackend(workerFile: string): Backend {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };

  const get = (): Worker => {
    if (worker) return worker;
    const w = new Worker(workerFile);
    w.on("message", (m: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
    });
    w.on("error", (e) => {
      if (worker === w) worker = null;
      failAll(e instanceof Error ? e : new Error(String(e)));
    });
    w.on("exit", (code) => {
      if (worker === w) worker = null;
      failAll(new Error(`Agentree's backend stopped (exit ${code}).`));
    });
    worker = w;
    return w;
  };

  const call = (method: MethodName, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      get().postMessage({ id, method, args });
    });

  const proxy = {} as Record<MethodName, (...a: unknown[]) => Promise<unknown>>;
  for (const m of [
    "listSessions",
    "getSession",
    "patchNode",
    "forkAt",
    "providerHealth",
    "watchTargets",
  ] satisfies MethodName[]) {
    proxy[m] = (...args) => call(m, args);
  }

  return {
    ...(proxy as unknown as Omit<Backend, "dispose">),
    dispose() {
      const w = worker;
      worker = null;
      failAll(new Error("Agentree's backend was closed."));
      void w?.terminate();
    },
  };
}
