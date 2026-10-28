import os from "node:os";
import { describe, expect, it } from "vitest";
import { nativeLink } from "../electron/native.ts";
import { terminalLaunch, usableCwd } from "../electron/terminal.ts";

const ID = "01a17c6d-c757-7562-9886-3e9876e35c5f";

describe("deep links into the harness extensions", () => {
  it("uses each extension's own URI handler", () => {
    expect(nativeLink({ provider: "claude", sessionId: ID, cwd: "" })).toBe(
      `vscode://anthropic.claude-code/open?session=${ID}`,
    );
    expect(nativeLink({ provider: "codex", sessionId: ID, cwd: "" }, "vscode-insiders")).toBe(
      `vscode-insiders://openai.chatgpt/local/${ID}`,
    );
  });

  it("refuses harnesses without an extension and anything that isn't an id", () => {
    expect(nativeLink({ provider: "copilot", sessionId: ID, cwd: "" })).toBeNull();
    expect(nativeLink({ provider: "claude", sessionId: "x&prompt=rm -rf", cwd: "" })).toBeNull();
  });
});

describe("OS terminal launch", () => {
  const argv = ["claude", "--resume", ID];

  it("Windows: a NEW console via `start`, quoted verbatim for cmd.exe", () => {
    expect(terminalLaunch(argv, "C:\\a b & c", "win32")).toEqual({
      cmd: "cmd.exe",
      args: ["/d", "/c", `start "" /D "C:\\a b & c" powershell.exe -NoExit -Command "claude --resume ${ID}"`],
      verbatim: true,
    });
  });

  it("macOS: Terminal.app with an escaped AppleScript string", () => {
    const l = terminalLaunch(argv, '/Users/me/say "hi"', "darwin")!;
    expect(l.cmd).toBe("osascript");
    expect(l.args[1]).toBe(
      `tell application "Terminal" to do script "cd '/Users/me/say \\"hi\\"' && claude --resume ${ID}"`,
    );
  });

  it("Linux: the first emulator on PATH, kept open afterwards", () => {
    const l = terminalLaunch(argv, "/home/me", "linux", (exe) => exe === "gnome-terminal")!;
    expect(l).toEqual({
      cmd: "gnome-terminal",
      args: ["--", "bash", "-lc", `cd /home/me && claude --resume ${ID}; exec bash`],
    });
    expect(terminalLaunch(argv, "/home/me", "linux", () => false)).toBeNull();
  });

  it("writes the harness's store into the command, which the window's shell may not inherit", () => {
    const env = { CLAUDE_CONFIG_DIR: "/srv/claude" };
    expect(terminalLaunch(argv, "C:\\w", "win32", undefined, { CLAUDE_CONFIG_DIR: "C:\\claude" })!.args[2]).toBe(
      `start "" /D "C:\\w" powershell.exe -NoExit -Command "$env:CLAUDE_CONFIG_DIR = 'C:\\claude'; claude --resume ${ID}"`,
    );
    expect(terminalLaunch(argv, "/home/me", "darwin", undefined, env)!.args[1]).toBe(
      `tell application "Terminal" to do script "cd /home/me && CLAUDE_CONFIG_DIR='/srv/claude' claude --resume ${ID}"`,
    );
  });

  it("falls back to home when the session's folder is gone", () => {
    expect(usableCwd("Z:\\definitely\\not\\here")).toBe(os.homedir());
    expect(usableCwd(os.tmpdir())).toBe(os.tmpdir());
  });
});
