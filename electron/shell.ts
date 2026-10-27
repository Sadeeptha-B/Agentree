/**
 * Ready-to-paste resume commands, spelled for the shell the user actually has.
 *
 * Sessions are stored per working directory, so a resume has to run from the
 * session's cwd — the change of directory is part of the command. POSIX shells
 * get `cd '…' && …`; Windows gets PowerShell 5.1 syntax, which is what a stock
 * Windows terminal (and VS Code's default Windows terminal) runs: 5.1 has no
 * `&&`, and `cd "…"` mangles paths with `[` `]` unless given -LiteralPath.
 */
export type Platform = "win32" | "posix";

export const hostPlatform = (): Platform => (process.platform === "win32" ? "win32" : "posix");

/** Single-quote a word for the target shell; ids and flags pass through bare. */
export function quote(word: string, platform: Platform = hostPlatform()): string {
  if (/^[A-Za-z0-9_\-=.:/@]+$/.test(word)) return word;
  return platform === "win32"
    ? `'${word.replace(/'/g, "''")}'`
    : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function resumeCommand(
  cwd: string,
  argv: string[],
  platform: Platform = hostPlatform(),
): string {
  const cmd = argv.map((a) => quote(a, platform)).join(" ");
  if (!cwd) return cmd;
  return platform === "win32"
    ? `Set-Location -LiteralPath ${quote(cwd, platform)}; ${cmd}`
    : `cd ${quote(cwd, platform)} && ${cmd}`;
}
