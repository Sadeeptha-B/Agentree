import { describe, expect, it } from "vitest";
import { quote, resumeCommand } from "../electron/shell.ts";

describe("resume commands", () => {
  it("emits PowerShell 5.1 syntax on Windows (no &&, literal path)", () => {
    expect(resumeCommand("C:\\Users\\me\\it's [x]", ["claude", "--resume", "abc-123"], "win32")).toBe(
      "Set-Location -LiteralPath 'C:\\Users\\me\\it''s [x]'; claude --resume abc-123",
    );
  });

  it("emits POSIX syntax elsewhere", () => {
    expect(resumeCommand("/home/me/it's", ["codex", "resume", "abc"], "posix")).toBe(
      "cd '/home/me/it'\\''s' && codex resume abc",
    );
  });

  it("leaves plain words bare and omits the cd without a cwd", () => {
    expect(quote("--resume=abc-1", "posix")).toBe("--resume=abc-1");
    expect(resumeCommand("", ["copilot", "--resume=x"], "win32")).toBe("copilot --resume=x");
  });
});
