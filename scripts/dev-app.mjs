// Starts Electron against the Vite dev server. A Node launcher rather than
// `VAR=value electron .` in package.json, which only POSIX shells understand —
// npm runs scripts through cmd.exe on Windows.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, AGENTVIEW_DEV_URL: process.env.AGENTVIEW_DEV_URL ?? "http://localhost:5173" },
});
child.on("exit", (code) => process.exit(code ?? 0));
