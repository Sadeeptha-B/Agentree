import fs from "node:fs";
import path from "node:path";
import { childIndex, countBranchPoints } from "../shared/render.ts";
import type {
  MemberInfo,
  NodeId,
  ProviderHealth,
  SessionDetail,
  SessionId,
  SessionMeta,
  TurnNode,
} from "../shared/types.ts";
import { HealthScan, minorVersion } from "./health.ts";
import { readLineage } from "./lineage.ts";
import { applyAnnotations } from "./meta.ts";
import { claudeProjects } from "./paths.ts";
import { RESUME_ARGV, resumeCommand } from "./shell.ts";
import { overlap, stitchFamily, type FamilyMember } from "./providers/stitch.ts";

function decodeProjectName(dirName: string): string {
  const parts = dirName.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dirName;
}

/** Last path segment of a POSIX or Windows path. */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

// ------------------------------------------------------------------ parsing

export interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  /**
   * A `/compact` writes a `system/compact_boundary` record with
   * `parentUuid: null` and the pre-compaction tip here — following it keeps a
   * compacted session one connected tree instead of a forest.
   */
  logicalParentUuid?: string | null;
  /** `system` records only, e.g. "compact_boundary". */
  subtype?: string;
  timestamp?: string;
  isSidechain?: boolean;
  cwd?: string;
  sessionId?: string;
  /** CLI version that wrote the record. */
  version?: string;
  /** "claude-vscode" | "cli" | … — which front end drove the session. */
  entrypoint?: string;
  /** Shared by the prompt record and every tool_result of that prompt. */
  promptId?: string;
  /**
   * Written by forks made through the Agent SDK's `forkSession` and by
   * Agentree's own fork: the parent session and the message forked after.
   */
  forkedFrom?: { sessionId?: string; messageUuid?: string };
  /** `queue-operation` only: enqueue | dequeue | remove. */
  operation?: string;
  /** `queue-operation` only: the text the user typed. */
  content?: unknown;
  /** `custom-title` only: the name set with `/rename` (or "<title> (fork)"). */
  customTitle?: string;
  /** `ai-title` only: the CLI's own generated title. */
  aiTitle?: string;
  /**
   * `attachment` records. `type: "queued_command"` ones are the harness's OWN
   * splice of a delivered mid-turn message into the lineage — real uuid, real
   * position — and are preferred over reconstructing from queue-operations.
   */
  attachment?: {
    type?: string;
    prompt?: string;
    /** "prompt" for the user's own /btw messages, "task-notification" for plumbing. */
    commandMode?: string;
    origin?: { kind?: string } | null;
  };
  /** Agentree-internal marker set when projecting a queued_command attachment. */
  agentreeMidTurn?: boolean;
  message?: {
    /** API message id. Shared by every record belonging to one assistant turn. */
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: Record<string, number>;
  };
}

/**
 * Record types this parser has met and knows to be either a turn or
 * bookkeeping it can ignore. Anything else is counted in the health row — not
 * an error (the lineage pass tolerates any type), but the first sign of a
 * format change.
 */
const KNOWN_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "summary",
  "progress",
  "queue-operation",
  "custom-title",
  "ai-title",
  "agent-name",
  "tag",
  "last-prompt",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "file-history-delta",
  // Request-capture bookkeeping. `api-request-blob` carries `message` content
  // blocks but is NOT a turn — only user/assistant records ever become nodes.
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "bridge-session",
  "atis-latch",
  "cost-state",
  "pr-link",
  "frame-link",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
]);

// Claude Code plumbing that leaks into `user` records as literal markup.
const ESC = String.fromCharCode(27);
/** CSI sequences — `\e[1m` and friends — from command output captured verbatim. */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
/**
 * Boilerplate addressed to the model, never written or read by the user. The
 * `ide_*` blocks are the VS Code extension's context injection ("The user
 * opened the file … in the IDE"); left in, they became most sessions' titles.
 */
const DROP_TAGS =
  "local-command-caveat|system-reminder|ide_opened_file|ide_selection|ide_diagnostics";
const DROP_BLOCKS = new RegExp(`<(${DROP_TAGS})>[\\s\\S]*?<\\/\\1>`, "g");
/**
 * A reminder can OPEN in one record and CLOSE in the next; when adjacent
 * records merge, the rejoined pair is caught by DROP_BLOCKS — but at a branch
 * point the merge doesn't happen and each half survives alone. After the
 * paired pass, an unpaired opener runs to end-of-record and an unpaired closer
 * back to its start, so drop those spans. The backtick guard spares prose
 * discussing the tag (`` `<system-reminder>` ``), which this repo's own
 * sessions are full of.
 */
const DROP_OPEN_TAIL = new RegExp("(?<!`)<(?:" + DROP_TAGS + ")>[\\s\\S]*$");
const DROP_CLOSE_HEAD = new RegExp("^[\\s\\S]*?<\\/(?:" + DROP_TAGS + ")>(?!`)");
const WRAPPERS = [
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "user-prompt-submit-hook",
  // `!`-prefixed bash mode in the CLI
  "bash-input",
  "bash-stdout",
  "bash-stderr",
].join("|");

/**
 * A background-task notification is a bundle of sub-tags (`task-id`,
 * `tool-use-id`, `output-file`, `status`, `summary`) that would render as raw
 * markup if merely unwrapped. Only `summary` is prose; the rest is plumbing —
 * so the whole block is rebuilt as its summary line. Handled before the
 * generic unwrap so the sub-tags never reach it (they're generic names like
 * `<status>` that must NOT be stripped when they appear in real content).
 */
const TASK_NOTIF = /<task-notification>([\s\S]*?)<\/task-notification>/g;
/**
 * The same bundle WITHOUT its wrapper: queued mid-turn messages surface task
 * notifications inline, so `<task-id>…` runs appear bare inside user records.
 * `<task-id>` is distinctive enough to anchor on; the generic-named sub-tags
 * are only consumed as part of a run that starts with it.
 */
const BARE_NOTIF =
  /<task-id>[\s\S]*?<\/task-id>(?:\s*<(tool-use-id|output-file|status|summary)>[\s\S]*?<\/\1>)*/g;
/**
 * Boilerplate paragraph the harness prints above task notifications
 * ("[SYSTEM NOTIFICATION - NOT USER INPUT] …"). Addressed to the model, never
 * typed by the user; matched as one contiguous paragraph.
 */
const SYSTEM_NOTIF = /\[SYSTEM NOTIFICATION - NOT USER INPUT\][^\n]*(?:\n(?!\s*\n)[^\n]*)*/g;

function rebuildTaskNotification(inner: string): string {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(inner);
  if (summary) return summary[1].trim();
  // No summary tag — drop the known plumbing sub-tags, keep whatever remains.
  const rest = inner
    .replace(/<(task-id|tool-use-id|output-file|status)>[\s\S]*?<\/\1>/g, "")
    .trim();
  return rest || "[background task update]";
}
/** Real content in a wrapper: keep the inner text (trimmed), lose the tag. */
const UNWRAP_BLOCKS = new RegExp(`<(${WRAPPERS})>([\\s\\S]*?)<\\/\\1>`, "g");
/** A wrapper whose partner tag lives in another record. */
const UNWRAP_STRAY = new RegExp(`</?(?:${WRAPPERS})>`, "g");

/**
 * Strip Claude Code plumbing that leaks into records as literal markup.
 *
 * Deliberately a SHORT allow-list of known wrapper tags, not "remove anything
 * angle-bracketed": conversations are full of real `<doc>`, `<name>`, `<email>`
 * markup inside code samples and quoted XML, and eating those would corrupt the
 * content it's meant to clean.
 */
export function cleanText(s: string): { text: string; synthetic: boolean } {
  let out = s
    .replace(ANSI, "")
    .replace(DROP_BLOCKS, "")
    .replace(DROP_OPEN_TAIL, "")
    .replace(DROP_CLOSE_HEAD, "")
    .replace(SYSTEM_NOTIF, "")
    .replace(TASK_NOTIF, (_m, inner: string) => rebuildTaskNotification(inner))
    .replace(BARE_NOTIF, (m) => rebuildTaskNotification(m));
  let synthetic = false;

  // A slash-command record is nothing but wrapper blocks, pretty-printed with
  // indentation. Unwrapping in place leaves that indentation stranded
  // ("/model\n            model"), so rebuild the record from the trimmed
  // inners instead. Only when the record is *entirely* wrappers — prose and
  // code must keep their whitespace.
  const inners = [...out.matchAll(UNWRAP_BLOCKS)].map((m) => m[2].trim());
  if (inners.length > 0 && out.replace(UNWRAP_BLOCKS, "").trim() === "") {
    out = inners.filter(Boolean).join("\n");
    // Nothing here but harness wrappers — real content never reaches this branch.
    synthetic = true;
  } else {
    out = out.replace(UNWRAP_BLOCKS, (_m, _tag, inner: string) => inner.trim());
  }

  const text = out
    .replace(UNWRAP_STRAY, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, synthetic };
}

function textOf(content: unknown): {
  text: string;
  thinking: string;
  tools: string[];
  synthetic: boolean;
} {
  if (typeof content === "string") {
    const c = cleanText(content);
    return { text: c.text, thinking: "", tools: [], synthetic: c.synthetic };
  }
  if (!Array.isArray(content)) return { text: "", thinking: "", tools: [], synthetic: false };

  let text = "";
  let thinking = "";
  let media = 0;
  const tools: string[] = [];
  for (const raw of content) {
    const b = raw as { type?: string; text?: string; thinking?: string; name?: string };
    switch (b.type) {
      case "text":
        text += b.text ?? "";
        break;
      case "thinking":
        thinking += b.thinking ?? "";
        break;
      case "tool_use":
        if (b.name) tools.push(b.name);
        break;
      case "image":
      case "document":
        media++;
        break;
      // tool_result blocks are the harness echoing output back; they'd swamp
      // the transcript view, so they're summarised by the tool_use name only.
      default:
        break;
    }
  }
  const cleaned = cleanText(text);
  text = cleaned.text;
  // An uncaptioned screenshot has no text but is a real turn, so label it
  // rather than letting the has-text filter drop it.
  if (!text && media > 0) text = media > 1 ? `[${media} attachments]` : "[image]";
  return { text, thinking: thinking.trim(), tools, synthetic: cleaned.synthetic };
}

/**
 * Fold a linear run of consecutive SAME-ROLE turns into one node.
 *
 * Assistant runs: once tool-result records are gone an agent loop is just
 * assistant → assistant → assistant. Each step is its own API message, but to a
 * reader it is one reply to one prompt.
 *
 * User runs: a slash command arrives as several records (the command name, its
 * stdout, hook output) before the next assistant turn.
 *
 * Either way the result is the alternating user↔assistant tree you want to look
 * at. Only merges where the parent has EXACTLY one child, so branch points are
 * never collapsed — a branch below the run simply re-parents onto the head. Nor
 * does a run cross from one session into another: a fork's first turn must
 * stay its own node, or the fork point (and its resume target) disappears.
 */
export function mergeSameRoleRuns(nodes: TurnNode[]): TurnNode[] {
  const kids = new Map<string, TurnNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? "\0root";
    const arr = kids.get(key);
    if (arr) arr.push(n);
    else kids.set(key, [n]);
  }

  const absorbed = new Set<NodeId>();
  const remap = new Map<NodeId, NodeId>(); // absorbed id -> surviving head id
  const out: TurnNode[] = [];

  for (const head of nodes) {
    if (absorbed.has(head.id)) continue;

    const parts: TurnNode[] = [head];
    let cur = head;
    for (;;) {
      const cs = kids.get(cur.id) ?? [];
      if (cs.length !== 1 || cs[0].role !== head.role) break;
      if (cs[0].crossSession || cs[0].sourceSessionId !== head.sourceSessionId) break;
      cur = cs[0];
      parts.push(cur);
      absorbed.add(cur.id);
      remap.set(cur.id, head.id);
    }

    if (parts.length === 1) {
      out.push(head);
      continue;
    }

    const last = parts[parts.length - 1];
    out.push({
      ...head,
      // Re-clean the joined text: a wrapper block can open in one record and
      // close in the next, which per-record cleaning cannot match.
      text: cleanText(parts.map((p) => p.text).join("\n\n")).text,
      thinking: parts.map((p) => p.thinking ?? "").filter(Boolean).join("\n\n") || undefined,
      toolUses: parts.flatMap((p) => p.toolUses ?? []),
      // Unlike the per-block merge — where every record repeats one message's
      // usage and summing would multiply it — each part here is a DISTINCT API
      // call, so summing is the real cost of the merged turn.
      usage: parts.reduce(
        (acc, p) => ({
          input_tokens: acc.input_tokens + (p.usage?.input_tokens ?? 0),
          output_tokens: acc.output_tokens + (p.usage?.output_tokens ?? 0),
          cache_creation_input_tokens:
            acc.cache_creation_input_tokens + (p.usage?.cache_creation_input_tokens ?? 0),
          cache_read_input_tokens:
            acc.cache_read_input_tokens + (p.usage?.cache_read_input_tokens ?? 0),
        }),
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      ),
      // Context size at the end of the run lives in the LAST call's usage —
      // see TurnNode.lastUsage. Parts are unmerged single calls here.
      lastUsage: last.lastUsage ?? last.usage,
      model: last.model ?? head.model,
      stopReason: last.stopReason ?? null,
      absorbedIds: parts.slice(1).flatMap((p) => [p.id, ...(p.absorbedIds ?? [])]),
      aliasIds: parts.flatMap((p) => p.aliasIds ?? []).length
        ? parts.flatMap((p) => p.aliasIds ?? [])
        : undefined,
      // The merged turn ends where its last ANCHORABLE part ends — that's the
      // record a fork has to resume after. An injected tail has no transcript
      // record at all, and a mid-turn attachment's uuid is a record the CLI's
      // resume loader doesn't index; either one becoming the anchor produces
      // a fork the CLI can only reject. With no anchorable part at all, the
      // last part's reason stands for the whole run.
      ...(() => {
        const anchor = [...parts].reverse().find((p) => !p.forkBlocked);
        return anchor
          ? { lastRawId: anchor.lastRawId ?? anchor.id, preCompact: anchor.preCompact, forkBlocked: undefined }
          : { lastRawId: last.lastRawId ?? last.id, preCompact: last.preCompact, forkBlocked: last.forkBlocked };
      })(),
      // Only wholly-synthetic runs are unforkable; one real record in the run
      // gives the merged turn a resume point.
      injected: parts.every((p) => p.injected) || undefined,
      midTurn: parts.every((p) => p.midTurn) || undefined,
    });
  }

  // Children of an absorbed turn now hang off the head that swallowed it.
  for (const n of out) {
    let p = n.parentId;
    while (p && remap.has(p)) p = remap.get(p)!;
    n.parentId = p ?? null;
  }
  return out;
}

interface Interjection {
  text: string;
  timestamp?: string;
  /** Last record written before the user typed this. */
  afterUuid: string | null;
  seqAt: number;
  recAt: number;
}

/** Synthetic uuid prefix. Never collides: real uuids are hex-and-dashes. */
export const INJECTED_PREFIX = "queued:";

/** Normalised prefix, for matching an interjection against a real record. */
const gist = (s: string, n = 80) => s.replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Give the user's mid-turn interjections a place in the tree.
 *
 * A message typed while Claude is still working never becomes a `user` record.
 * It is written once as `{"type":"queue-operation","operation":"enqueue",…}` —
 * no uuid, no parentUuid — and if it is then delivered *into* the running turn
 * (queue op `remove`, as opposed to `dequeue`) no record is ever created for
 * it. The conversation the model saw contains it; the transcript's DAG does
 * not, so the tree was silently dropping whole instructions.
 *
 * Each surviving interjection is synthesised as a user turn and spliced INTO
 * the chain — the record that followed it is re-parented onto it — rather than
 * hung off the side. Hanging it off the side would turn every interjection into
 * a spurious branch point, which is exactly the signal this app exists to show.
 *
 * The re-parent only happens when the following record still points at the
 * record the interjection came after. If it points somewhere else the user
 * rewound or branched in between, and inventing a link would misreport history.
 */
function spliceInterjections(
  sessionId: string,
  queued: Interjection[],
  records: RawRecord[],
  parentOf: Map<string, string | null>,
  seq: string[],
): void {
  if (queued.length === 0) return;

  // An enqueue that was later `dequeue`d became a normal prompt and is already
  // in the transcript. Match on content rather than on the queue ops: `remove`
  // is used both for "delivered mid-turn" and for "user deleted it", and the
  // record itself is the only reliable evidence of which happened.
  const said = new Set<string>();
  for (const r of records) {
    if (r.type !== "user") continue;
    const c = r.message?.content;
    if (typeof c === "string") said.add(gist(c));
    else if (Array.isArray(c)) {
      for (const b of c as { type?: string; text?: string }[]) {
        if (b.type === "text" && b.text) said.add(gist(b.text));
      }
    }
  }

  // Consecutive interjections must chain, not fan out from a shared parent.
  const tip = new Map<string, string>();
  const inserts: { at: number; rec: RawRecord }[] = [];
  let n = 0;

  for (const q of queued) {
    if (said.has(gist(q.text))) continue;

    const key = q.afterUuid ?? "\0root";
    const parent = tip.get(key) ?? q.afterUuid;
    // Session-qualified: a family tree holds several transcripts' interjections.
    const uuid = `${INJECTED_PREFIX}${sessionId.slice(0, 8)}:${n++}`;

    parentOf.set(uuid, parent);
    for (let k = q.seqAt; k < seq.length; k++) {
      if ((parentOf.get(seq[k]) ?? null) === parent) {
        parentOf.set(seq[k], uuid);
        break;
      }
    }
    tip.set(key, uuid);

    inserts.push({
      at: q.recAt,
      rec: {
        type: "user",
        uuid,
        parentUuid: parent,
        timestamp: q.timestamp,
        message: { role: "user", content: q.text },
      },
    });
  }

  // Back to front so earlier indices stay valid.
  for (let i = inserts.length - 1; i >= 0; i--) {
    records.splice(inserts[i].at, 0, inserts[i].rec);
  }
}

export interface Parsed {
  sessionId: string;
  /**
   * One node per API message / user record — NOT yet folded by
   * mergeSameRoleRuns, because family stitching must match turn-for-turn
   * before runs are merged (a merge boundary can differ between a parent,
   * which branches mid-run, and its fork, which doesn't).
   */
  nodes: TurnNode[];
  /** Stitch evidence per node id: `m:<message.id>` / `u:<promptId>|<gist>`. */
  keys: Map<NodeId, string>;
  /**
   * Every assistant API message id in the file. The API mints one per
   * response, and a copy-fork preserves the ones it copies, so two files
   * sharing ANY of them share history — whichever branch the fork copied.
   */
  messageIds: string[];
  /**
   * Set when the file should have been a session and isn't: unreadable, no
   * parseable line at all, or conversation records that yielded no turn.
   * Bookkeeping-only files (the CLI writes those) leave it unset.
   */
  problem?: "unreadable" | "malformed" | "unrecognized";
  /**
   * custom-title (last) > ai-title (last) > first real prompt. The prompt is
   * computed BEFORE merging: a merged node can start with slash-command
   * plumbing followed by the real question.
   */
  title: string;
  /** Newest timestamp on ANY record, displayed or not. 0 if none carried one. */
  touchedAt: number;
  cwd: string;
  entrypoint?: string;
  version?: string;
  /** Explicit lineage stamped by SDK / Agentree forks. */
  forkedFrom?: string;
  unknownTypes: Record<string, number>;
}

const EMPTY = (sessionId: string, problem?: Parsed["problem"]): Parsed => ({
  sessionId,
  nodes: [],
  keys: new Map(),
  messageIds: [],
  problem,
  title: "",
  touchedAt: 0,
  cwd: "",
  unknownTypes: {},
});

/**
 * Read a transcript's records. Torn lines (a session mid-append) are skipped
 * but counted, so a file that is ALL unparseable can be told apart from an
 * empty one.
 */
function readLines(file: string): { records: RawRecord[]; bad: number } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const records: RawRecord[] = [];
  let bad = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (r && typeof r === "object") records.push(r as RawRecord);
      else bad++;
    } catch {
      bad++; // torn line
    }
  }
  return { records, bad };
}

export const readRecords = (file: string): RawRecord[] | null => readLines(file)?.records ?? null;

/**
 * Why a fork can't anchor at a turn — one place, so the panel and the fork
 * writer can't disagree.
 */
const BLOCK = {
  injected: "This message was delivered mid-turn and Claude Code wrote no record for it, so there is nothing to fork at.",
  midTurn:
    "This mid-turn message can't anchor a fork itself. Fork the turn after it — forks that pass this point keep the message.",
  preCompact:
    "This turn is from before the session's last /compact. Claude Code resumes a compacted session from its summary, so Agentree only forks after the compaction.",
};

/** Project a transcript file into the node list. Read-only — we never write here. */
export function parseFile(file: string): Parsed {
  const sessionId = path.basename(file).replace(/\.jsonl$/, "");
  const read = readLines(file);
  if (!read) return EMPTY(sessionId, "unreadable");
  if (read.records.length === 0) return EMPTY(sessionId, read.bad > 0 ? "malformed" : undefined);
  const all = read.records;

  // Pass 1: the FULL lineage, including record types we don't display.
  //
  // Claude Code interleaves `attachment`, `system`, `file-history-snapshot`
  // and friends into the same parent chain. Filtering them out without
  // re-linking leaves most parentUuid pointers dangling, which collapses the
  // whole tree to a handful of reachable nodes.
  const parentOf = new Map<string, string | null>();
  const records: RawRecord[] = [];
  let touchedAt = 0;
  let cwd = "";
  let entrypoint: string | undefined;
  let version: string | undefined;
  let forkedFrom: string | undefined;
  const unknownTypes: Record<string, number> = {};

  /** uuids in file order, so an interjection can be spliced at the right point. */
  const seq: string[] = [];
  const queued: Interjection[] = [];
  /** Name set with `/rename` or by a fork. Last one wins. */
  let customTitle = "";
  let aiTitle = "";
  /**
   * Everything recorded before the LAST `/compact` boundary. The CLI's loader
   * only indexes messages after it, so these uuids cannot anchor a fork.
   */
  const preCompact = new Set<string>();

  for (const rec of all) {
    if (rec.type && !KNOWN_TYPES.has(rec.type)) {
      unknownTypes[rec.type] = (unknownTypes[rec.type] ?? 0) + 1;
    }
    if (rec.timestamp) {
      const t = Date.parse(rec.timestamp);
      if (t > touchedAt) touchedAt = t;
    }
    if (!cwd && rec.cwd) cwd = rec.cwd;
    if (!entrypoint && rec.entrypoint) entrypoint = rec.entrypoint;
    if (rec.version) version = rec.version;
    if (!forkedFrom && rec.forkedFrom?.sessionId) forkedFrom = rec.forkedFrom.sessionId;

    // Titles are uuid-less records, so this has to run before the `!rec.uuid` bail.
    if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
      customTitle = rec.customTitle;
      continue;
    }
    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      aiTitle = rec.aiTitle;
      continue;
    }

    if (rec.type === "queue-operation" && rec.operation === "enqueue" && typeof rec.content === "string") {
      // Background-task notifications ride the SAME queue as the user's own
      // mid-turn (`/btw`) messages: the harness enqueues the notification text
      // and `remove`s it when delivered into the running turn. Splicing those
      // in would show system plumbing as hollow "user" turns the user never
      // typed — the very confusion this feature exists to avoid. Only entries
      // that BEGIN as a notification are dropped; a real message that quotes
      // one (e.g. "btw, <task-id>… renders weirdly") starts with prose and is
      // kept.
      if (/^\s*(\[SYSTEM NOTIFICATION - NOT USER INPUT\]|<task-notification>)/.test(rec.content)) {
        continue;
      }
      queued.push({
        text: rec.content,
        timestamp: rec.timestamp,
        afterUuid: seq.length ? seq[seq.length - 1] : null,
        seqAt: seq.length,
        recAt: records.length,
      });
      continue;
    }

    if (!rec.uuid) continue;
    // Lineage is recorded for EVERY record, displayable or not, so that
    // resolveParent can re-link children across whatever we filter out.
    //
    // `logicalParentUuid` bridges a compact boundary's physical null parent —
    // without it a compacted session falls apart into a forest. In a
    // copy-fork it is STALE: the extension's fork gives every record a fresh
    // uuid but leaves this field pointing into the parent's file (read from
    // its forkSession, 2.1.310). A copy is written in chain order, so the
    // record just before the boundary is that logical parent.
    let parent = rec.parentUuid ?? null;
    if (parent === null && rec.logicalParentUuid) {
      parent = parentOf.has(rec.logicalParentUuid)
        ? rec.logicalParentUuid
        : seq.length
          ? seq[seq.length - 1]
          : null;
    }
    parentOf.set(rec.uuid, parent);
    seq.push(rec.uuid);

    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      for (const u of seq) preCompact.add(u);
    }

    if (rec.type === "user" || rec.type === "assistant") {
      records.push(rec);
    } else if (
      rec.type === "attachment" &&
      rec.attachment?.type === "queued_command" &&
      typeof rec.attachment.prompt === "string" &&
      rec.attachment.origin?.kind === "human" &&
      rec.attachment.commandMode !== "task-notification"
    ) {
      // The harness's own record of a delivered mid-turn message: project it
      // as a user turn. It has a real uuid at the real delivery point, and —
      // verified against the live CLI — any fork of a LATER turn retains it.
      // (Task notifications ride the same attachment type with
      // `commandMode: "task-notification"` and a null origin; those are
      // plumbing and are left out of the tree.)
      records.push({
        type: "user",
        uuid: rec.uuid,
        parentUuid: rec.parentUuid,
        timestamp: rec.timestamp,
        isSidechain: rec.isSidechain,
        promptId: rec.promptId,
        message: { role: "user", content: rec.attachment.prompt },
        agentreeMidTurn: true,
      });
    }
  }

  // Queue-operation reconstruction covers only transcripts old enough to lack
  // queued_command attachments; spliceInterjections' content dedup (`said`)
  // sees the attachment-projected user records above and drops duplicates.
  spliceInterjections(sessionId, queued, records, parentOf, seq);

  // Pass 1b: coalesce each assistant turn back into a single node.
  //
  // Claude Code writes ONE RECORD PER CONTENT BLOCK: a reply with thinking +
  // text + a tool call becomes three chained `assistant` records that share one
  // API `message.id`. Drawn naively that's three nodes per turn, two of them
  // with no text. Group by message.id and keep only the first record of each
  // group; `resolveParent` below then re-links children past the absorbed ones.
  const groups: RawRecord[][] = [];
  const groupOfKey = new Map<string, RawRecord[]>();
  const messageIds: string[] = [];

  for (const rec of records) {
    const key =
      rec.type === "assistant" && rec.message?.id ? `msg:${rec.message.id}` : null;
    const existing = key ? groupOfKey.get(key) : undefined;
    if (key && !existing) messageIds.push(rec.message!.id!);
    if (existing) {
      existing.push(rec);
    } else {
      const group = [rec];
      groups.push(group);
      if (key) groupOfKey.set(key, group);
    }
  }

  // Pass 1c: merge each group's blocks, then keep only turns that actually
  // SAID something.
  //
  // A turn whose whole content was a tool call renders as "(no text)" and tells
  // the reader nothing — in an agentic session those outnumber the real turns.
  // The filter is on merged text, so it has to run after the merge: a turn that
  // is thinking + tool_use + one line of prose must survive as that one line.
  // Whatever is dropped, `resolveParent` re-links children across.
  interface Draft {
    head: RawRecord;
    last: RawRecord;
    text: string;
    thinking: string;
    tools: string[];
    synthetic: boolean;
  }

  const drafts: Draft[] = groups.map((group) => {
    let text = "";
    let thinking = "";
    let synthetic = true;
    const tools: string[] = [];
    for (const rec of group) {
      const part = textOf(rec.message?.content);
      text += part.text;
      thinking += part.thinking;
      tools.push(...part.tools);
      if (part.text && !part.synthetic) synthetic = false;
    }
    return {
      head: group[0],
      last: group[group.length - 1],
      text,
      thinking,
      tools,
      synthetic,
    };
  });

  const visible = drafts.filter((d) => d.text.trim().length > 0);
  const kept = new Set(visible.map((d) => d.head.uuid!));

  /** Nearest ancestor that survives the display filter. */
  const resolveParent = (uuid: string): string | null => {
    const seen = new Set<string>([uuid]);
    let p = parentOf.get(uuid) ?? null;
    while (p !== null) {
      if (kept.has(p)) return p;
      if (seen.has(p)) return null; // malformed transcript; don't loop
      seen.add(p);
      p = parentOf.get(p) ?? null;
    }
    return null;
  };

  // Pass 2: project the surviving turns.
  const nodes: TurnNode[] = [];
  const keys = new Map<NodeId, string>();
  for (const { head, last, text, thinking, tools } of visible) {
    // Every record in a group repeats the same message-level usage, so take one
    // rather than summing — summing would multiply a turn's cost by its block
    // count and wreck the overlays.
    const u = last.message?.usage ?? head.message?.usage;
    const id = head.uuid!;
    const injected = id.startsWith(INJECTED_PREFIX);
    const midTurn = !!head.agentreeMidTurn;
    const beforeCompact = preCompact.has(last.uuid!);

    nodes.push({
      id,
      parentId: resolveParent(id),
      // Last record of the message group: a reply is written one record per
      // content block, and a fork must anchor on the block the turn ends with.
      lastRawId: last.uuid!,
      sourceSessionId: sessionId,
      role: head.type as TurnNode["role"],
      text,
      thinking: thinking || undefined,
      toolUses: tools.length ? tools : undefined,
      model: head.message?.model,
      // stop_reason lands on the final block of the turn.
      stopReason: last.message?.stop_reason ?? null,
      isSidechain: head.isSidechain || undefined,
      // No transcript record backs this turn — see spliceInterjections.
      injected: injected || undefined,
      // Backed by a queued_command attachment — real record, but not a valid
      // resume anchor itself.
      midTurn: midTurn || undefined,
      // Anchor predates the last /compact.
      preCompact: beforeCompact || undefined,
      forkBlocked: injected
        ? BLOCK.injected
        : midTurn
          ? BLOCK.midTurn
          : beforeCompact
            ? BLOCK.preCompact
            : undefined,
      timestamp: head.timestamp ? Date.parse(head.timestamp) : 0,
      usage: u
        ? {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          }
        : undefined,
    });

    // Stitch evidence a copy-fork preserves verbatim (uuids are NOT preserved):
    // the API message id for replies, the prompt id plus text for prompts.
    // NOT the timestamp: a fork re-stamps its last copied record, so a fork
    // ending on a prompt without a promptId (older transcripts) would no
    // longer match its own source. Stitching only matches under an already
    // matched parent, which is what keeps the text alone safe there.
    keys.set(
      id,
      head.type === "assistant" && head.message?.id
        ? `m:${head.message.id}`
        : `u:${head.promptId ?? ""}|${gist(text)}`,
    );
  }
  // Conversation records that produced nothing is what a changed record shape
  // looks like — as opposed to a file of pure bookkeeping, which has none.
  const problem = nodes.length === 0 && records.some((r) => r.type === "user" || r.type === "assistant")
    ? "unrecognized"
    : nodes.length === 0 && read.bad > all.length
      ? "malformed"
      : undefined;
  const titleDraft = visible.find(
    (d) => d.head.type === "user" && !d.synthetic && !d.text.startsWith("[Request interrupted"),
  );

  return {
    sessionId,
    nodes,
    keys,
    messageIds,
    problem,
    // A name the user chose with `/rename` beats the CLI's generated title,
    // which beats anything inferred from the first prompt.
    title:
      customTitle.trim() ||
      aiTitle.trim() ||
      (titleDraft?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
    touchedAt,
    cwd,
    entrypoint,
    version,
    forkedFrom,
    unknownTypes,
  };
}

// ------------------------------------------------------------------ lookup

interface Located {
  file: string;
  cwd: string;
  dirName: string;
}

const isSessionId = (id: string) => /^[a-zA-Z0-9-]{8,64}$/.test(id);

/** Find a session's transcript (cheap: one existsSync per project dir). */
export function locate(sessionId: SessionId): Located | null {
  if (!isSessionId(sessionId)) return null;
  const root = claudeProjects();
  if (!fs.existsSync(root)) return null;

  for (const dirName of fs.readdirSync(root)) {
    const file = path.join(root, dirName, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return { file, cwd: readCwd(file), dirName };
  }
  return null;
}

function readCwd(file: string): string {
  // The cwd recorded inside the transcript is authoritative; the directory
  // name is a lossy encoding (/, \, : and . all collapse to -).
  try {
    for (const l of fs.readFileSync(file, "utf8").split("\n", 40)) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l) as RawRecord;
        if (o.cwd) return o.cwd;
      } catch {
        /* keep scanning */
      }
    }
  } catch {
    /* fall through */
  }
  return "";
}

export const claudeResumeArgv = RESUME_ARGV.claude;

/** Sessions are per-directory, so the change of directory is part of the command. */
const claudeResume = (sessionId: SessionId, cwd: string) =>
  resumeCommand(cwd, claudeResumeArgv(sessionId));

// ------------------------------------------------------------------ summaries

/**
 * Per-file summary cache, keyed by file identity (mtime + size).
 *
 * The welcome screen scans every transcript, and there are hundreds of them
 * totalling hundreds of MB — one full scan is ~700ms and a few hundred MB of
 * garbage. With a live watcher that scan reruns whenever *any* session changes,
 * so re-parsing the files that didn't change is nearly all of the cost.
 *
 * Only metadata is cached, never the node array: keeping every session's turns
 * resident would trade a CPU problem for a much worse memory one.
 */
interface FileSummary {
  file: string;
  dirName: string;
  id: SessionId;
  mtimeMs: number;
  size: number;
  /** File creation time — orders a fork after the session it was copied from. */
  createdMs: number;
  title: string;
  cwd: string;
  updatedAt: number;
  nodeCount: number;
  branchPoints: number;
  entrypoint?: string;
  version?: string;
  messageIds: string[];
  forkedFrom?: string;
  problem?: Parsed["problem"];
  unknownTypes: Record<string, number>;
}

const summaries = new Map<string, FileSummary>();

function summarise(file: string, dirName: string): FileSummary | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const hit = summaries.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;

  const parsed = parseFile(file);
  const merged = mergeSameRoleRuns(parsed.nodes);
  const s: FileSummary = {
    file,
    dirName,
    id: parsed.sessionId,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    createdMs: stat.birthtimeMs || parsed.nodes[0]?.timestamp || stat.mtimeMs,
    title: parsed.title,
    cwd: parsed.cwd,
    // The newest record's own timestamp, not the file's mtime (which moves
    // when the CLI rewrites bookkeeping for a session nobody is talking in),
    // and not the newest *displayed* turn (which stands still through a long
    // tool loop, making an actively-running session look minutes stale).
    updatedAt: parsed.touchedAt || stat.mtimeMs,
    nodeCount: merged.length,
    branchPoints: countBranchPoints(childIndex(merged)),
    entrypoint: parsed.entrypoint,
    version: parsed.version,
    messageIds: parsed.messageIds,
    forkedFrom: parsed.forkedFrom,
    problem: parsed.problem,
    unknownTypes: parsed.unknownTypes,
  };
  summaries.set(file, s);
  return s;
}

/** Every transcript in one project directory, summarised. */
function summariseDir(dirName: string, seen?: Set<string>): FileSummary[] {
  const dir = path.join(claudeProjects(), dirName);
  const out: FileSummary[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const file = path.join(dir, f);
    seen?.add(file);
    const s = summarise(file, dirName);
    if (s) out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------ families

/**
 * Group one project directory's transcripts into fork families.
 *
 * The VS Code extension's "Fork conversation" writes a NEW transcript holding a
 * copy of one chain of its source (fresh uuids, same API message ids, same
 * prompt ids, same timestamps) and records no lineage at all. The API mints a
 * message id once per response, so two files that share ANY assistant message
 * id share history, however similar or different their opening prompts. Any,
 * not the first: a fork copies the branch it was taken on, which need not
 * contain the file's earliest reply (a regenerated first answer, say).
 * Explicit lineage (`forkedFrom` on SDK/Agentree forks, Agentree's sidecar)
 * links families too.
 */
function groupFamilies(files: FileSummary[]): FileSummary[][] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const lineage = readLineage();
  const byMessage = new Map<string, string>();
  for (const f of files) {
    if (f.nodeCount === 0) continue;
    if (f.forkedFrom && byId.has(f.forkedFrom)) union(f.id, f.forkedFrom);
    const side = lineage[f.id];
    if (side && byId.has(side)) union(f.id, side);
    for (const m of f.messageIds) {
      const other = byMessage.get(m);
      if (other) union(f.id, other);
      else byMessage.set(m, f.id);
    }
  }

  const groups = new Map<string, FileSummary[]>();
  for (const f of files) {
    if (f.nodeCount === 0) continue;
    const r = find(f.id);
    const g = groups.get(r);
    if (g) g.push(f);
    else groups.set(r, [f]);
  }
  return [...groups.values()];
}

const asMember = (id: string, p: Parsed, parentSessionId: string | null = null): FamilyMember => ({
  sessionId: id,
  parentSessionId,
  nodes: p.nodes,
  keyOf: (n) => p.keys.get(n.id) ?? n.id,
});

/**
 * Decide who forked from whom inside one family. Three steps, each unable to
 * contradict the one before:
 *
 *  1. Explicit lineage (`forkedFrom`, the sidecar) — an edge that would close
 *     a cycle is dropped rather than trusted.
 *  2. An order with every explicit ancestor before its descendants; inside
 *     that, by how many " (fork)" suffixes the extension stamped on titles,
 *     then by file creation time. Both are weak (a rename drops the suffix, a
 *     restored directory resets creation times), which is why they only order
 *     what step 1 left free.
 *  3. A member without explicit lineage takes the EARLIER member whose tree
 *     holds the most of its history (`overlap`, over every branch of both): a
 *     fork of a fork overlaps its direct parent more than the root, even after
 *     that parent rewound. Every edge points backwards in the order, so the
 *     result is a forest — never a cycle.
 */
function familyParents(group: FileSummary[], parsed: Map<string, Parsed>): Map<string, string | null> {
  const lineage = readLineage();
  const ids = new Set(group.map((g) => g.id));

  const explicit = new Map<string, string>();
  const isAncestor = (a: string, of: string) => {
    const seen = new Set<string>();
    for (let cur = explicit.get(of); cur && !seen.has(cur); cur = explicit.get(cur)) {
      if (cur === a) return true;
      seen.add(cur);
    }
    return false;
  };
  for (const m of [...group].sort((a, b) => a.createdMs - b.createdMs)) {
    const p = [m.forkedFrom, lineage[m.id]].find((x) => x && ids.has(x) && x !== m.id);
    if (p && p !== m.id && !isAncestor(m.id, p)) explicit.set(m.id, p);
  }

  const forkDepth = (t: string) => (t.match(/\(fork\)/g) ?? []).length;
  const remaining = [...group].sort(
    (a, b) => forkDepth(a.title) - forkDepth(b.title) || a.createdMs - b.createdMs,
  );
  const order: FileSummary[] = [];
  const placed = new Set<string>();
  while (remaining.length) {
    const i = Math.max(
      0,
      remaining.findIndex((m) => !explicit.has(m.id) || placed.has(explicit.get(m.id)!)),
    );
    const [m] = remaining.splice(i, 1);
    order.push(m);
    placed.add(m.id);
  }

  const fm = new Map(group.map((g) => [g.id, asMember(g.id, parsed.get(g.id)!)]));
  const out = new Map<string, string | null>();
  order.forEach((m, i) => {
    const e = explicit.get(m.id);
    if (e) {
      out.set(m.id, e);
      return;
    }
    let best: string | null = null;
    let bestN = 0;
    for (let j = 0; j < i; j++) {
      const n = overlap(fm.get(m.id)!, fm.get(order[j].id)!);
      if (n > bestN) {
        bestN = n;
        best = order[j].id;
      }
    }
    out.set(m.id, best);
  });
  return out;
}

interface Family {
  rootId: string;
  nodes: TurnNode[];
  members: MemberInfo[];
}

/** Parse, order and stitch one family into a single merged tree. */
function buildFamily(group: FileSummary[]): Family {
  const parsed = new Map(group.map((g) => [g.id, parseFile(g.file)]));
  const parents = group.length > 1 ? familyParents(group, parsed) : new Map([[group[0].id, null]]);
  const rootId = [...group]
    .sort((a, b) => a.createdMs - b.createdMs)
    .find((g) => !parents.get(g.id))!.id;

  const fm = group.map((g) => asMember(g.id, parsed.get(g.id)!, parents.get(g.id) ?? null));
  // Root first so its node ids are the ones the shared prefix keeps.
  fm.sort((a, b) => (a.sessionId === rootId ? -1 : b.sessionId === rootId ? 1 : 0));

  const nodes = mergeSameRoleRuns(group.length > 1 ? stitchFamily(fm) : parsed.get(group[0].id)!.nodes.map((n) => ({ ...n })));
  const members: MemberInfo[] = group.map((g) => ({
    id: g.id,
    title: g.title || "Untitled",
    parentId: parents.get(g.id) ?? null,
    cwd: g.cwd,
    resumeCommand: claudeResume(g.id, g.cwd),
    updatedAt: g.updatedAt,
    entrypoint: g.entrypoint,
  }));
  return { rootId, nodes, members };
}

/** Family-level meta cache, keyed by every member file's identity. */
const familyMetas = new Map<string, SessionMeta>();
const signature = (group: FileSummary[]) =>
  group.map((g) => `${g.file}:${g.mtimeMs}:${g.size}`).sort().join("|");

function familyMeta(group: FileSummary[], built?: Family): SessionMeta {
  const updatedAt = Math.max(...group.map((g) => g.updatedAt));

  if (group.length === 1) {
    const g = group[0];
    return {
      id: g.id,
      provider: "claude",
      cwd: g.cwd,
      project: g.cwd ? baseName(g.cwd) : decodeProjectName(g.dirName),
      title: g.title || "Untitled",
      updatedAt,
      nodeCount: g.nodeCount,
      branchPoints: g.branchPoints,
      resumeCommand: claudeResume(g.id, g.cwd),
      members: 1,
      entrypoint: g.entrypoint,
    };
  }

  const sig = signature(group);
  const hit = familyMetas.get(sig);
  if (hit) return hit;
  const fam = built ?? buildFamily(group);
  const r = group.find((g) => g.id === fam.rootId)!;
  const meta: SessionMeta = {
    id: fam.rootId,
    provider: "claude",
    cwd: r.cwd,
    project: r.cwd ? baseName(r.cwd) : decodeProjectName(r.dirName),
    title: r.title || "Untitled",
    updatedAt,
    nodeCount: fam.nodes.length,
    branchPoints: countBranchPoints(childIndex(fam.nodes)),
    resumeCommand: claudeResume(fam.rootId, r.cwd),
    members: group.length,
    entrypoint: r.entrypoint,
  };
  familyMetas.set(sig, meta);
  return meta;
}

// ------------------------------------------------------------------ API

let lastHealth: ProviderHealth | null = null;
export const claudeHealth = (): ProviderHealth =>
  lastHealth ?? new HealthScan("claude", claudeProjects()).done();

export function listSessions(opts: { limit?: number } = {}): SessionMeta[] {
  const root = claudeProjects();
  const health = new HealthScan("claude", root);
  const out: SessionMeta[] = [];
  const seen = new Set<string>();

  if (fs.existsSync(root)) {
    for (const dirName of fs.readdirSync(root)) {
      try {
        if (!fs.statSync(path.join(root, dirName)).isDirectory()) continue;
      } catch {
        continue;
      }
      const files = summariseDir(dirName, seen);
      for (const f of files) {
        health.file();
        if (f.problem) health.failed();
        else if (f.nodeCount === 0) health.skipped();
        else health.parsed();
        health.version(f.version ? `claude ${minorVersion(f.version)}` : undefined);
        health.unknown(f.unknownTypes);
      }
      for (const group of groupFamilies(files)) out.push(familyMeta(group));
    }
  }

  // Forget deleted transcripts, so the caches can't outgrow the directory.
  for (const key of summaries.keys()) if (!seen.has(key)) summaries.delete(key);
  if (familyMetas.size > 500) familyMetas.clear();

  health.listed(out.length);
  lastHealth = health.done();
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Load the family containing `sessionId` — any member id opens the whole tree. */
export function loadSession(sessionId: SessionId): SessionDetail | null {
  const loc = locate(sessionId);
  if (!loc) return null;

  const files = summariseDir(loc.dirName);
  const group = groupFamilies(files).find((g) => g.some((f) => f.id === sessionId));
  if (!group) {
    // A transcript with no displayable turn yet (e.g. a fork nobody has
    // spoken in): open it as an empty tree rather than "not found".
    const s = files.find((f) => f.id === sessionId);
    if (!s) return null;
    return {
      meta: familyMeta([s]),
      nodes: [],
      members: [],
    };
  }

  const fam = buildFamily(group);
  applyAnnotations(fam.nodes, fam.members.map((m) => m.id));

  return {
    meta: familyMeta(group, fam),
    nodes: fam.nodes,
    members: fam.members,
  };
}
