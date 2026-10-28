import fs from "node:fs";
import path from "node:path";
import { agentreeHome } from "./paths.ts";
import type { SessionId } from "../shared/types.ts";

/**
 * Fork lineage sidecar: child session id -> parent session id.
 *
 * Codex records lineage itself (`forked_from_id` in an append-only rollout the
 * CLI never rewrites), but Copilot REGENERATES workspace.yaml on every resume
 * and silently drops unknown keys — verified by forking, resuming, and finding
 * the `forked_from` key gone. So the durable copy of "which session this fork
 * came from" has to live in a file only Agentree writes.
 */
const FILE = () => path.join(agentreeHome(), "lineage.json");

let cache: { stamp: string; all: Record<SessionId, SessionId> } | null = null;

/** Read on every listing, per family: cached by the file's identity. */
export function readLineage(): Record<SessionId, SessionId> {
  let stamp: string;
  try {
    const st = fs.statSync(FILE());
    stamp = `${FILE()}:${st.mtimeMs}:${st.size}`;
  } catch {
    return {};
  }
  if (cache?.stamp === stamp) return cache.all;
  try {
    cache = { stamp, all: JSON.parse(fs.readFileSync(FILE(), "utf8")) as Record<SessionId, SessionId> };
    return cache.all;
  } catch {
    return {};
  }
}

/**
 * The entries a family's grouping and parentage are read from: its
 * members'. Part of the family's revision — a fork of another family
 * recorded here doesn't change it.
 */
export const lineageOf = (ids: SessionId[]): string => {
  const all = readLineage();
  return [...ids].sort().map((id) => `${id}>${all[id] ?? ""}`).join(",");
};

export function recordLineage(child: SessionId, parent: SessionId): void {
  const all = readLineage();
  all[child] = parent;
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1), "utf8");
  fs.renameSync(tmp, FILE());
}
