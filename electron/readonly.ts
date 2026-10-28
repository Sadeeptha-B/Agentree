import type { ActionResult } from "../shared/types.ts";

/**
 * `AGENTREE_READ_ONLY_STORES`: Agentree never writes to an agent's store or
 * hands a session to the agent, which would write to it. Forks (the only
 * writes Agentree makes there) are refused in the worker; opening in the
 * agent's chat panel and resuming in a terminal are refused by each host.
 * Agentree's own home (settings, annotations, lineage) is unaffected: point
 * `AGENTREE_HOME` at a scratch directory for that.
 *
 * For audits and automated runs against real stores (the run-desktop skill's
 * `real` mode): a guard at the action, not at whatever control triggers it.
 * Any nonempty value except `0` turns it on. Imports nothing, so both hosts
 * and the worker can check it.
 */
export const storesReadOnly = (): boolean => {
  const v = process.env.AGENTREE_READ_ONLY_STORES?.trim();
  return !!v && v !== "0";
};

export const READ_ONLY_STORES =
  "Agentree is running with read-only agent stores (AGENTREE_READ_ONLY_STORES): it doesn't fork, open or resume sessions.";

/** The refusal for a hand-off to the agent, or null when hand-offs are allowed. */
export const handOffRefused = (): ActionResult | null =>
  storesReadOnly() ? { ok: false, error: READ_ONLY_STORES } : null;
