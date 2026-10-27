import path from "node:path";
import { describe, expect, it } from "vitest";
import { startBackend } from "../electron/backend-client.ts";

const FAKE = path.join(__dirname, "fake-worker.cjs");

describe("backend worker client", () => {
  it("a dying worker's late exit can't fail a retry already sent to its replacement", async () => {
    const b = startBackend(FAKE);
    try {
      // The worker dies: "error" fails the call, the caller retries at once
      // (a new worker), and only THEN does the old worker's "exit" arrive.
      let retry: Promise<unknown> | undefined;
      await b.getSession("crash").catch(() => {
        retry = b.getSession("after the crash");
      });
      expect(retry).toBeDefined();
      await expect(retry!).resolves.toBe("after the crash");
    } finally {
      b.dispose();
    }
  });

  it("is final once disposed", async () => {
    const b = startBackend(FAKE);
    await expect(b.getSession("hello")).resolves.toBe("hello");
    const inFlight = b.getSession("never answered");
    b.dispose();
    await expect(inFlight).rejects.toThrow(/closed/);
    await expect(b.getSession("too late")).rejects.toThrow(/closed/);
  });
});
