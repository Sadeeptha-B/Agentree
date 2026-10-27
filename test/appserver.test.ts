import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { forkThread } from "../electron/providers/codex-appserver.ts";

/**
 * The real client against a fake `codex app-server` (test/fake-codex): the
 * spawn, the initialize handshake, the request, and the ways a server process
 * goes wrong. The fork's request shape against the REAL server was verified
 * by hand on codex-cli 0.164 (see docs/design.md, "Codex fork"); this keeps the
 * client's own behaviour from regressing.
 */
const dir = path.join(__dirname, "fake-codex");
const run = (mode: string) => {
  process.env.FAKE_CODEX_MODE = mode;
  return forkThread({ threadId: "t-1", lastTurnId: "turn-1" });
};

beforeAll(() => {
  // Windows reaches the script through a .cmd shim (as npm installs codex)
  // whose path has a space, so cmd.exe's quoting is exercised too.
  if (process.platform === "win32") {
    process.env.AGENTREE_CODEX_BIN = path.join(dir, "fake codex.cmd");
  } else {
    const bin = path.join(dir, "fake-codex.mjs");
    fs.chmodSync(bin, 0o755);
    process.env.AGENTREE_CODEX_BIN = bin;
  }
});

describe("codex app-server client", () => {
  it("initializes, then sends thread/fork with exactly threadId, lastTurnId, excludeTurns", async () => {
    const res = await run("ok");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.threadId).toBe("fake-thread");
    // The fake echoes the params back as the cwd.
    expect(JSON.parse(res.cwd)).toEqual({ threadId: "t-1", lastTurnId: "turn-1", excludeTurns: true });
  });

  it("surfaces a JSON-RPC error as the fork's error", async () => {
    expect(await run("error")).toEqual({ ok: false, error: "fork refused" });
  });

  it("fails at once when the server exits with a request outstanding", async () => {
    const t0 = Date.now();
    const res = await run("exit");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/exited/);
    expect(Date.now() - t0).toBeLessThan(10_000); // not the 60 s request timeout
  });
});
