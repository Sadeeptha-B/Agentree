// Generates the synthetic transcript fixtures under test/fixtures/.
//
// Every record shape here was copied from real transcripts (Claude Code
// 2.1.310 VS Code extension, codex-cli 0.162 VS Code extension) with the
// content replaced — no user data is committed. Re-run after changing it:
//
//   node test/fixtures/make-fixtures.mjs
//
// The output is committed, so a format regression shows up as a test failure
// rather than depending on whatever happens to be in the developer's home dir.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const write = (rel, recs, { zst = false } = {}) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Buffer.from(jsonl(recs));
  fs.writeFileSync(file, zst ? zlib.zstdCompressSync(body) : body);
};
const ts = (min) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();

// ------------------------------------------------------------------ Claude
//
// One project dir holding:
//   P  a session with three prompts and a rewind branch after prompt 2;
//   F  the VS Code extension's "Fork conversation" of P after prompt 2
//      (fresh uuids, same message/prompt ids, custom-title "(fork)");
//   S  an unrelated session with the SAME opening prompt but its own replies
//      (must never merge with P).

const CLAUDE = "claude/2.1/projects/c--work-demo";
const P = "11111111-1111-4111-8111-111111111111";
const F = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const CWD = "C:\\work\\demo";
const common = (sessionId) => ({
  isSidechain: false,
  cwd: CWD,
  sessionId,
  version: "2.1.310",
  entrypoint: "claude-vscode",
});
const user = (sessionId, uuid, parentUuid, min, promptId, content) => ({
  parentUuid,
  ...common(sessionId),
  promptId,
  type: "user",
  message: { role: "user", content },
  uuid,
  timestamp: ts(min),
});
const asst = (sessionId, uuid, parentUuid, min, id, content) => ({
  parentUuid,
  ...common(sessionId),
  type: "assistant",
  message: {
    id,
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
  },
  requestId: `req_${id}`,
  uuid,
  timestamp: ts(min),
});
const text = (t) => ({ type: "text", text: t });
const IDE = "<ide_opened_file>The user opened the file c:\\work\\demo\\README.md in the IDE. This may or may not be related to the current task.</ide_opened_file>";

const parent = [
  user(P, "p-u1", null, 0, "prompt-1", [text(IDE), text("Explain the build")]),
  asst(P, "p-a1a", "p-u1", 1, "msg_1", [{ type: "thinking", thinking: "Look at package.json." }]),
  asst(P, "p-a1b", "p-a1a", 1, "msg_1", [text("The build uses esbuild.")]),
  // Request-capture bookkeeping that carries message content but is NOT a turn.
  { type: "api-request-blob", uuid: "p-blob", parentUuid: "p-a1b", message: { role: "user", content: [text("NOT A TURN")] }, timestamp: ts(1) },
  user(P, "p-u2", "p-a1b", 2, "prompt-2", "Now add tests"),
  asst(P, "p-a2", "p-u2", 3, "msg_2", [text("Added vitest.")]),
  user(P, "p-u3", "p-a2", 4, "prompt-3", "Ship it"),
  asst(P, "p-a3", "p-u3", 5, "msg_3", [text("Shipped.")]),
  // Rewind: a second child of p-a2, inside the same transcript.
  user(P, "p-u3b", "p-a2", 6, "prompt-4", "Actually, wait"),
  asst(P, "p-a3b", "p-u3b", 7, "msg_4", [text("Waiting.")]),
  { type: "ai-title", aiTitle: "Build walkthrough", sessionId: P },
  { type: "last-prompt", leafUuid: "p-a3b", lastPrompt: "Actually, wait", sessionId: P },
];
write(`${CLAUDE}/${P}.jsonl`, parent);

const fork = [
  user(F, "f-u1", null, 0, "prompt-1", [text(IDE), text("Explain the build")]),
  asst(F, "f-a1a", "f-u1", 1, "msg_1", [{ type: "thinking", thinking: "Look at package.json." }]),
  asst(F, "f-a1b", "f-a1a", 1, "msg_1", [text("The build uses esbuild.")]),
  user(F, "f-u2", "f-a1b", 2, "prompt-2", "Now add tests"),
  // The extension re-stamps the LAST copied record with the fork time.
  asst(F, "f-a2", "f-u2", 30, "msg_2", [text("Added vitest.")]),
  { type: "custom-title", sessionId: F, customTitle: "Build walkthrough (fork)" },
  user(F, "f-u3", "f-a2", 31, "prompt-5", "Try rollup instead"),
  asst(F, "f-a3", "f-u3", 32, "msg_5", [text("Switched to rollup.")]),
];
write(`${CLAUDE}/${F}.jsonl`, fork);

write(`${CLAUDE}/${S}.jsonl`, [
  user(S, "s-u1", null, 40, "prompt-9", "Explain the build"),
  asst(S, "s-a1", "s-u1", 41, "msg_9", [text("A different answer.")]),
]);

// ------------------------------------------------------------------ Codex
//
// CODEX_HOME holding one family of paginated pages:
//   T1   root thread: turns A, B (plain .jsonl)
//   T1_E prompt-edit page of T1, cut before B: turn B' (.jsonl.zst)
//   T3   archived thread forked from T1 after A: turn C
//   T2   live thread forked from T3 after C: turn D with a steering message
// plus a guardian-review thread (hidden), a page whose base is gone, a
// session_index naming T1, and a legacy (pre-paginated) rollout with a
// copy-prefix fork.

const CODEX = "codex/0.162/home";
const T1 = "01900000-0000-7000-8000-000000000001";
const T1_E = "01900000-0000-7000-8000-0000000000e1";
const T2 = "01900000-0000-7000-8000-000000000002";
const T3 = "01900000-0000-7000-8000-000000000003";
const G = "01900000-0000-7000-8000-000000000009";
const T4 = "01900000-0000-7000-8000-000000000004";
const turn = (n) => `01900000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const CX_CWD = "C:\\work\\codex-demo";

const meta = (id, extra = {}) => ({
  timestamp: ts(0),
  type: "session_meta",
  payload: {
    session_id: id,
    id,
    timestamp: ts(0),
    cwd: CX_CWD,
    originator: "codex_vscode",
    cli_version: "0.162.1",
    source: "vscode",
    thread_source: "user",
    model_provider: "openai",
    history_mode: "paginated",
    base_instructions: { text: "x".repeat(2000) },
    ...extra,
  },
});

/** One turn's records, starting at ordinal `o`. Returns [records, nextOrdinal]. */
function cxTurn(thread, tid, o, min, prompt, replies, { steer, ide } = {}) {
  const r = [];
  const at = (rec) => r.push({ timestamp: ts(min), ordinal: o++, ...rec });
  const item = (item) => at({ type: "event_msg", payload: { type: "item_completed", thread_id: thread, turn_id: tid, item } });
  at({ type: "event_msg", payload: { type: "task_started", turn_id: tid, root_turn_id: tid, turn_attribution: { turn_id: tid, turn_trigger: "composer" } } });
  at({ type: "turn_context", payload: { model: "gpt-6.1-sol" } });
  item({
    type: "UserMessage",
    id: "item-1",
    content: [{ type: "text", text: ide ? `# Context from my IDE setup:\n\n## Open tabs:\n- notes.md: notes.md\n\n## My request:\n${prompt}` : prompt, text_elements: [] }],
  });
  item({ type: "Reasoning", id: "rs_1", summary_text: ["Thinking it over."], raw_content: [] });
  item({ type: "AgentMessage", id: "item-2", content: [{ type: "Text", text: replies[0] }], phase: "commentary" });
  item({ type: "CommandExecution", id: "exec-1", command: ["pwsh", "-c", "ls"], status: "completed" });
  if (steer) {
    item({ type: "UserMessage", id: "item-3", content: [{ type: "text", text: steer, text_elements: [] }] });
  }
  item({ type: "AgentMessage", id: "item-4", content: [{ type: "Text", text: replies[1] }], phase: "final_answer" });
  at({ type: "token_usage_record", payload: { thread_id: thread, turn_id: tid, usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50 } } });
  at({ type: "event_msg", payload: { type: "task_complete", turn_id: tid } });
  return [r, o];
}

let o = 1;
let a, b, c, d, e;
[a, o] = cxTurn(T1, turn(1), o, 1, "What is X?", ["Looking.", "X is Y."], { ide: true });
const cutAfterA = o; // ordinal where turn B starts
[b, o] = cxTurn(T1, turn(2), o, 2, "Explain more", ["Reading.", "More detail."]);
write(`${CODEX}/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${T1}.jsonl`, [meta(T1), ...a, ...b]);

let oe = o;
[e, oe] = cxTurn(T1, turn(3), oe, 3, "Explain differently", ["Rethinking.", "Different detail."]);
write(
  `${CODEX}/sessions/2026/10/01/rollout-2026-10-01T10-05-00-${T1}_${T1_E}.jsonl.zst`,
  [meta(T1, { history_base: { thread_id: T1, end_ordinal_exclusive: cutAfterA } }), ...e],
  { zst: true },
);

let o3 = cutAfterA;
[c, o3] = cxTurn(T3, turn(4), o3, 4, "Fork question", ["Forking.", "Fork answer."]);
write(`${CODEX}/archived_sessions/rollout-2026-10-01T10-10-00-${T3}.jsonl`, [
  meta(T3, { forked_from_id: T1, forked_from_ordinal_exclusive: cutAfterA, history_base: { thread_id: T1, end_ordinal_exclusive: cutAfterA } }),
  ...c,
]);

let o2 = o3;
[d, o2] = cxTurn(T2, turn(5), o2, 5, "Grandchild", ["On it.", "Grandchild answer."], { steer: "also this" });
write(`${CODEX}/sessions/2026/10/02/rollout-2026-10-02T09-00-00-${T2}.jsonl`, [
  meta(T2, { forked_from_id: T3, forked_from_ordinal_exclusive: o3, history_base: { thread_id: T3, end_ordinal_exclusive: o3 } }),
  ...d,
]);

const [g] = cxTurn(G, turn(9), 1, 6, "Review this command", ["Reviewing.", "Approved."]);
write(`${CODEX}/sessions/2026/10/02/rollout-2026-10-02T09-30-00-${G}.jsonl`, [
  meta(G, { thread_source: "guardian_review", source: { subagent: { other: "guardian" } } }),
  ...g,
]);

const [t4] = cxTurn(T4, turn(6), 50, 7, "Orphaned continuation", ["Hm.", "Base is gone."]);
write(`${CODEX}/sessions/2026/10/03/rollout-2026-10-03T09-00-00-${T4}.jsonl`, [
  meta(T4, { history_base: { thread_id: "01900000-0000-7000-8000-00000000dead", end_ordinal_exclusive: 50 } }),
  ...t4,
]);

fs.writeFileSync(
  path.join(ROOT, CODEX, "session_index.jsonl"),
  jsonl([
    { id: T1, thread_name: "Old name", updated_at: ts(1) },
    { id: T1, thread_name: "X investigation", updated_at: ts(2) },
  ]),
);

// Legacy (pre-paginated) rollout and a copy-prefix fork of it.
const L = "01800000-0000-7000-8000-000000000001";
const L2 = "01800000-0000-7000-8000-000000000002";
const legacyMeta = (id, extra = {}) => ({ timestamp: ts(0), type: "session_meta", payload: { id, cwd: CX_CWD, cli_version: "0.145.0", ...extra } });
const ev = (type, message, min) => ({ timestamp: ts(min), type: "event_msg", payload: { type, message } });
const legacyPrefix = [ev("user_message", "Legacy hello", 1), ev("agent_message", "Legacy hi.", 2)];
write(`${CODEX}/sessions/2026/07/01/rollout-2026-07-01T10-00-00-${L}.jsonl`, [
  legacyMeta(L),
  ...legacyPrefix,
  ev("user_message", "Legacy parent continues", 3),
  ev("agent_message", "Parent reply.", 4),
]);
write(`${CODEX}/sessions/2026/07/01/rollout-2026-07-01T11-00-00-${L2}.jsonl`, [
  legacyMeta(L2, { forked_from_id: L }),
  ...legacyPrefix,
  ev("user_message", "Legacy fork continues", 5),
  ev("agent_message", "Fork reply.", 6),
]);

console.log("fixtures written under", ROOT);
