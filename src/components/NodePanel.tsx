import { useMemo, useState } from "react";
import { useStore } from "../store.ts";
import { api } from "../api.ts";
import type { ActionResult, ForkResult, MemberInfo, ProviderId, SessionRef } from "../../shared/types.ts";
import { contextAt, costOf, inferWindow, pathToRoot } from "../../shared/render.ts";
import { Markdown } from "../markdown.tsx";
import { pct, tokens, when } from "../format.ts";

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`copy ${done ? "done" : ""}`}
      title={value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          // Clipboard API needs a secure context; localhost qualifies, but a
          // denied permission shouldn't look like success.
          setDone(false);
          return;
        }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "✓ copied" : label}
    </button>
  );
}

/** A merged turn can carry dozens of calls; show unique names with counts. */
function toolSummary(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(" · ");
}

/** The harnesses with a VS Code extension Agentree can hand a session to. */
const NATIVE: Partial<Record<ProviderId, string>> = { claude: "Claude Code", codex: "Codex" };

/**
 * Open / resume buttons for one session. Inside VS Code the session goes to
 * its harness's own chat panel (or an integrated terminal); the desktop app
 * offers the copyable command, spelled for the host OS's shell.
 */
function SessionActions({ ref_, resumeCmd }: { ref_: SessionRef; resumeCmd: string }) {
  const [status, setStatus] = useState<ActionResult | null>(null);
  const native = NATIVE[ref_.provider];
  const run = async (fn: () => Promise<ActionResult>) => {
    try {
      setStatus(await fn());
    } catch (e) {
      setStatus({ ok: false, error: String(e) });
    }
  };
  return (
    <>
      <div className="copy-row">
        {api.host === "vscode" && native && (
          <button className="copy" onClick={() => void run(() => api.openNative(ref_))}>
            open in {native}
          </button>
        )}
        {api.host === "vscode" && (
          <button className="copy" onClick={() => void run(() => api.resumeInTerminal(ref_))}>
            resume in terminal
          </button>
        )}
        <Copy value={resumeCmd} label="copy resume command" />
        <Copy value={ref_.sessionId} label="copy id" />
      </div>
      {status && !status.ok && <p className="error-text small hint">{status.error}</p>}
    </>
  );
}

export function NodePanel() {
  const { session, nodes, selected, patch, setStatus } = useStore();
  const [editingLabel, setEditingLabel] = useState(false);
  const [fork, setFork] = useState<ForkResult | null>(null);
  const [opened, setOpened] = useState<ActionResult | null>(null);
  const [forking, setForking] = useState(false);

  // A fork belongs to the turn it was taken at; keep showing it while that turn
  // stays selected, and drop it the moment the user moves on.
  const [forkFor, setForkFor] = useState<string | null>(null);
  const forkResult = forkFor === selected ? fork : null;

  // Same pattern for the prefix view: it belongs to the turn it was opened on,
  // so selecting another node falls back to that node's own text.
  const [prefixFor, setPrefixFor] = useState<string | null>(null);
  const showPrefix = prefixFor === selected;

  // Inferred once per session; every node's percentage shares it.
  const window_ = useMemo(() => inferWindow(session?.nodes ?? []), [session]);

  if (!session) return null;
  const meta = session.meta;
  const node = selected ? nodes.get(selected) : null;
  const cost = costOf(node ?? undefined);
  const ctx = node ? contextAt(node.id, nodes) : null;
  const depth = node ? pathToRoot(node.id, nodes).length : 0;

  // A family tree mixes sessions: resume/open/fork act on the session the
  // selected turn belongs to, not on the family root.
  const members = session.members ?? [];
  const memberId = node?.sourceSessionId ?? meta.id;
  const member: MemberInfo =
    members.find((m) => m.id === memberId) ?? {
      id: meta.id,
      title: meta.title,
      parentId: null,
      cwd: meta.cwd,
      resumeCommand: meta.resumeCommand,
      updatedAt: meta.updatedAt,
    };
  const parentTitle = member.parentId ? members.find((m) => m.id === member.parentId)?.title : null;
  const ref_: SessionRef = { provider: meta.provider, sessionId: member.id, cwd: member.cwd };

  const doFork = async () => {
    if (!node) return;
    setForking(true);
    setForkFor(node.id);
    setOpened(null);
    try {
      const res = await api.forkAt(meta.id, node.id);
      setFork(res);
      // In VS Code the fork goes straight to the harness's own chat panel.
      if (res.ok && res.open && api.host === "vscode" && NATIVE[res.open.provider]) {
        setOpened(await api.openNative(res.open));
      }
    } catch (e) {
      setFork({ ok: false, error: String(e) });
    } finally {
      setForking(false);
    }
  };

  return (
    <aside className="panel">
      <section className="panel-block session-block">
        <h3>
          Conversation <span className={`provider-chip ${meta.provider}`}>{meta.provider}</span>
          {members.length > 1 && <span className="muted small">{members.length} sessions</span>}
        </h3>
        <div className="kv">
          <span className="muted small">cwd</span>
          <code className="path" title={meta.cwd}>
            {meta.cwd || "—"}
          </code>
        </div>
      </section>

      <section className="panel-block member-block">
        <h3>
          Session
          {member.parentId && <span className="fork-badge">fork</span>}
          {member.archived && <span className="fork-badge">archived</span>}
        </h3>
        <div className="member-title">{member.title}</div>
        {parentTitle && <p className="muted small hint">forked from “{parentTitle}”</p>}
        <div className="kv">
          <span className="muted small">id</span>
          <code className="id">{member.id}</code>
        </div>
        <SessionActions ref_={ref_} resumeCmd={member.resumeCommand} />
        <p className="muted small hint">
          Resumes this session at its own latest turn. To branch from an earlier turn, select it
          and use “⑂ fork after this turn”.
        </p>
      </section>

      {!node ? (
        <section className="panel-block">
          <p className="muted small">Select a node in the tree.</p>
        </section>
      ) : (
        <>
          <section className="panel-block">
            <div className="panel-head">
              <span className={`role ${node.role}`}>{node.role}</span>
              <span className="muted small">
                depth {depth} · {when(node.timestamp)}
                {node.absorbedIds?.length ? (
                  <> · {node.absorbedIds.length + 1} turns merged</>
                ) : null}
              </span>
            </div>

            {ctx != null && (
              <div className="muted small stats">
                <span title="How much of the model's context window the conversation fills at this point. The next message — or a branch from here — sends all of it. Window size inferred from usage.">
                  context {tokens(ctx)} · {pct(ctx / window_)} of window
                </span>
                {node.usage && (
                  <>
                    {" · "}
                    <span title="Prompt tokens already sent across this turn's API calls — what this turn has cost you. A tool-using turn replays the history once per call, so this can exceed the context size.">
                      prompt {tokens(cost.promptTokens)}
                    </span>
                  </>
                )}
              </div>
            )}

            <div className="panel-actions">
              {!node.injected && <Copy value={node.id} label="copy node id" />}
              <button
                className="ghost"
                title="Dims this turn and everything under it"
                onClick={() =>
                  void setStatus(node.id, node.status === "dead-end" ? undefined : "dead-end")
                }
              >
                {node.status === "dead-end" ? "revive" : "mark dead end"}
              </button>
              <button
                className="ghost"
                onClick={() =>
                  void setStatus(node.id, node.status === "favorite" ? undefined : "favorite")
                }
              >
                {node.status === "favorite" ? "unstar" : "star"}
              </button>
              <button className="ghost" onClick={() => setEditingLabel(true)}>
                label
              </button>
            </div>

            {node.injected && (
              <p className="muted small hint">
                Sent mid-turn; Claude Code wrote no record for it, so it can't be forked at.
              </p>
            )}
            {node.midTurn && !node.injected && (
              <p className="muted small hint">
                {meta.provider === "codex"
                  ? "Sent while Codex was working; it belongs to the same turn, so a fork here includes that whole turn."
                  : "Sent mid-turn. Forks of any later turn keep this message; it just can't anchor a fork itself."}
              </p>
            )}

            <div className="panel-actions">
              <button
                className="primary"
                title={
                  node.injected
                    ? "No transcript record to fork from"
                    : "Create a new session holding the conversation up to this turn"
                }
                disabled={forking || node.injected}
                onClick={() => void doFork()}
              >
                {forking ? "forking…" : "⑂ fork after this turn"}
              </button>
            </div>

            {forkResult &&
              (forkResult.ok ? (
                <div className="fork-result">
                  <p className="small">
                    {opened?.ok
                      ? `Forked and opened in ${NATIVE[meta.provider]}.`
                      : "Forked into a new session. It joins this tree as soon as it has a turn of its own."}
                  </p>
                  {opened && !opened.ok && <p className="error-text small">{opened.error}</p>}
                  <code className="path fork-cmd">{forkResult.command}</code>
                  <div className="copy-row">
                    <Copy value={forkResult.command} label="⑂ copy resume command" />
                    <Copy value={forkResult.id} label="copy session id" />
                    {api.host === "vscode" && forkResult.open && !opened?.ok && (
                      <button
                        className="copy"
                        onClick={async () => setOpened(await api.resumeInTerminal(forkResult.open!))}
                      >
                        resume in terminal
                      </button>
                    )}
                  </div>
                  {forkResult.note && <p className="muted small hint">{forkResult.note}</p>}
                </div>
              ) : (
                <div className="fork-result error-text">{forkResult.error}</div>
              ))}

            {editingLabel && (
              <input
                className="label-input"
                autoFocus
                defaultValue={node.label ?? ""}
                placeholder="Label this branch…"
                onBlur={(e) => {
                  void patch(node.id, { label: e.target.value || undefined });
                  setEditingLabel(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingLabel(false);
                }}
              />
            )}
          </section>

          {node.thinking && (
            <section className="panel-block">
              <details className="thinking">
                <summary>thinking</summary>
                <div className="md thinking-body">
                  <Markdown text={node.thinking} />
                </div>
              </details>
            </section>
          )}

          {node.toolUses?.length ? (
            <section className="panel-block">
              <div className="tool-strip muted small">⚒ {toolSummary(node.toolUses)}</div>
            </section>
          ) : null}

          <section className="panel-block grow">
            <div className="prefix-toggle">
              <button
                className="ghost"
                title="Read the whole conversation from the root down to this turn"
                onClick={() => setPrefixFor(showPrefix ? null : node.id)}
              >
                {showPrefix ? "show this turn only" : "view conversation up to here"}
              </button>
            </div>
            {showPrefix ? (
              <div className="panel-body md prefix-view">
                {pathToRoot(node.id, nodes).map((p) => (
                  <div key={p.id} className={`prefix-turn ${p.role}`}>
                    <div className="prefix-role muted small">
                      {p.role}
                      {p.injected || p.midTurn ? " · mid-turn" : ""} · {when(p.timestamp)}
                    </div>
                    <Markdown text={p.text} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="panel-body md">
                <Markdown text={node.text} />
              </div>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
