import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionResult } from "../shared/types.ts";
import { quote, resumeCommand } from "./shell.ts";

/**
 * Open a NEW OS terminal window running a resume command — the desktop app's
 * counterpart to VS Code's integrated terminal.
 *
 * - Windows: PowerShell in a new console window via `cmd /c start /D <cwd>`
 *   (`-NoExit` keeps it open after the agent quits), so the command itself
 *   is just the argv.
 * - macOS: Terminal.app via `osascript … do script`.
 * - Linux: the first terminal emulator on PATH, running a login bash that
 *   stays open afterwards.
 *
 * Pure Node (no Electron import): the extension never needs it, but the main
 * process does, and keeping it Electron-free keeps it testable.
 */
export interface Launch {
  cmd: string;
  args: string[];
  cwd?: string;
  /** Pass `args` to the process exactly as written (Windows cmd.exe quoting). */
  verbatim?: boolean;
}

const onPath = (exe: string): boolean =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((d) => d && fs.existsSync(path.join(d, exe)));

/** A session's cwd can be gone (repo moved or deleted); the agent CLI still finds the session. */
export const usableCwd = (cwd: string): string =>
  cwd && fs.existsSync(cwd) ? cwd : os.homedir();

export function terminalLaunch(
  argv: string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  has: (exe: string) => boolean = onPath,
): Launch | null {
  if (platform === "win32") {
    // `start` is what gives the shell a NEW console window: Node's `detached`
    // maps to DETACHED_PROCESS on Windows, i.e. no console at all, and a
    // console program spawned that way never shows up (verified). Quoting is
    // done here, verbatim: Windows paths can't contain `"`, and the PowerShell
    // command uses single quotes only, so double-quoting both is safe even
    // for paths with `&` or `^` in them.
    const ps = argv.map((a) => quote(a, "win32")).join(" ");
    return {
      cmd: "cmd.exe",
      args: ["/d", "/c", `start "" /D "${cwd}" powershell.exe -NoExit -Command "${ps}"`],
      verbatim: true,
    };
  }
  const posix = resumeCommand(cwd, argv, "posix");
  if (platform === "darwin") {
    // AppleScript string literal: escape backslashes and double quotes.
    const script = posix.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      cmd: "osascript",
      args: ["-e", `tell application "Terminal" to do script "${script}"`, "-e", 'tell application "Terminal" to activate'],
    };
  }
  const keepOpen = `${posix}; exec bash`;
  const candidates: [string, string[]][] = [
    ["x-terminal-emulator", ["-e", "bash", "-lc", keepOpen]],
    ["gnome-terminal", ["--", "bash", "-lc", keepOpen]],
    ["konsole", ["-e", "bash", "-lc", keepOpen]],
    ["xfce4-terminal", ["-x", "bash", "-lc", keepOpen]],
    ["xterm", ["-e", "bash", "-lc", keepOpen]],
  ];
  const hit = candidates.find(([exe]) => has(exe));
  return hit ? { cmd: hit[0], args: hit[1] } : null;
}

export function openTerminal(argv: string[], cwd: string): ActionResult {
  const launch = terminalLaunch(argv, usableCwd(cwd));
  if (!launch) return { ok: false, error: "No terminal emulator found on PATH." };
  try {
    const child = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      // POSIX: outlive the app. Windows: cmd.exe exits as soon as `start`
      // has opened the new console, so it needs neither.
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
    });
    child.on("error", () => {});
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Couldn't open a terminal: ${e instanceof Error ? e.message : String(e)}` };
  }
}
