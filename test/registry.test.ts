import { describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../shared/types.ts";

const entry = (updatedAt: number, title: string): SessionMeta => ({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  provider: "claude",
  cwd: "",
  project: "",
  title,
  updatedAt,
  nodeCount: 1,
  branchPoints: 0,
  resumeCommand: "",
});

// A provider that regressed: the same session twice.
vi.mock("../electron/transcripts.ts", async (orig) => ({
  ...(await orig<typeof import("../electron/transcripts.ts")>()),
  listSessions: () => [entry(1, "older"), entry(2, "newer")],
}));
vi.mock("../electron/providers/codex.ts", async (orig) => ({
  ...(await orig<typeof import("../electron/providers/codex.ts")>()),
  listCodexSessions: () => [],
}));
vi.mock("../electron/providers/copilot.ts", async (orig) => ({
  ...(await orig<typeof import("../electron/providers/copilot.ts")>()),
  listCopilotSessions: () => [],
}));

const { listAllSessions } = await import("../electron/registry.ts");

describe("registry list", () => {
  it("never lists one provider:id twice, and keeps the newer entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = listAllSessions();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("newer");
    expect(warn).toHaveBeenCalledOnce();
  });
});
