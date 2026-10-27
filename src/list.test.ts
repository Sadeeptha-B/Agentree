import { describe, expect, it } from "vitest";
import { cwdKey } from "../shared/render.ts";
import type { SessionMeta } from "../shared/types.ts";
import { filterSessions, railDirs } from "./list.ts";

const meta = (id: string, cwd: string, activeAt: number, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  provider: "claude",
  cwd,
  project: "",
  title: id,
  activeAt,
  touchedAt: activeAt,
  nodeCount: 1,
  branchPoints: 0,
  resumeCommand: "",
  ...extra,
});

describe("directory keys", () => {
  it("treats the spellings one session records for a folder as one directory", () => {
    const k = cwdKey("C:\\work\\new");
    expect(cwdKey("c:\\work\\new\\")).toBe(k);
    expect(cwdKey("/c/work/new")).toBe(k);
    expect(cwdKey("c:/work/new/")).toBe(k);
    // Only the drive letter folds; the rest of a path may be case-sensitive.
    expect(cwdKey("C:\\Work\\new")).not.toBe(k);
    expect(cwdKey("/home/me/repo/")).toBe("/home/me/repo");
    expect(cwdKey("C:\\")).toBe("c:/");
  });

  it("ranks rail directories by recency and shows the newest spelling", () => {
    const rail = railDirs([meta("a", "C:\\work\\new", 1), meta("b", "/c/work/new", 3), meta("c", "C:\\other", 2)]);
    expect(rail).toEqual([
      { key: cwdKey("C:\\work\\new"), path: "/c/work/new", n: 2 },
      { key: cwdKey("C:\\other"), path: "C:\\other", n: 1 },
    ]);
    const list = filterSessions([meta("a", "C:\\work\\new", 1), meta("b", "/c/work/new", 3), meta("c", "C:\\other", 2)], {
      query: "",
      cwd: rail[0].key,
    });
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  });
});
