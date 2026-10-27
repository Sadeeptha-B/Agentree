import os from "node:os";
import path from "node:path";

/**
 * Every on-disk root Agentree reads or writes, resolved lazily.
 *
 * Each harness honours its own override variable (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`), so following them is simply correct for users who relocate
 * their config. It also lets the test suite point every provider at fixtures
 * without touching the real home directory. Functions rather than constants:
 * a value captured at module load would ignore an override set afterwards.
 */
const home = () => os.homedir();

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
export const claudeProjects = () => path.join(claudeHome(), "projects");

export const codexHome = () => process.env.CODEX_HOME || path.join(home(), ".codex");
export const codexSessions = () => path.join(codexHome(), "sessions");
export const codexArchived = () => path.join(codexHome(), "archived_sessions");
export const codexIndex = () => path.join(codexHome(), "session_index.jsonl");

export const copilotState = () =>
  process.env.COPILOT_HOME
    ? path.join(process.env.COPILOT_HOME, "session-state")
    : path.join(home(), ".copilot", "session-state");

/** Agentree's own sidecars: annotations and fork lineage. */
export const agentreeHome = () => process.env.AGENTREE_HOME || path.join(home(), ".agentree");
