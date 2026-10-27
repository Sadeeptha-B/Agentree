import os from "node:os";
import path from "node:path";
import { configuredPath } from "./settings.ts";

/**
 * Every on-disk root Agentree reads or writes, resolved lazily.
 *
 * Each harness honours its own override variable (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `COPILOT_HOME`), so following them is simply correct for
 * users who relocate their config. It also lets the test suite point every
 * provider at fixtures without touching the real home directory. After the
 * environment come Agentree's own settings (`configuredPath`), then the
 * default. Functions rather than constants: a value captured at module load
 * would ignore an override set, or a setting changed, afterwards.
 */
const home = () => os.homedir();

export const claudeHome = () => configuredPath("claudeConfigDir") || path.join(home(), ".claude");
export const claudeProjects = () => path.join(claudeHome(), "projects");

export const codexHome = () => configuredPath("codexHome") || path.join(home(), ".codex");
export const codexSessions = () => path.join(codexHome(), "sessions");
export const codexArchived = () => path.join(codexHome(), "archived_sessions");
export const codexIndex = () => path.join(codexHome(), "session_index.jsonl");

export const copilotState = () => path.join(configuredPath("copilotHome") || path.join(home(), ".copilot"), "session-state");

/** Agentree's own sidecars: annotations, fork lineage, settings. Environment only. */
export { agentreeHome } from "./settings.ts";
