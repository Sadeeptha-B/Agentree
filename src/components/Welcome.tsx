import { useMemo, useState } from "react";
import { useStore } from "../store.ts";
import { when } from "../format.ts";
import type { ProviderHealth } from "../../shared/types.ts";
import { filterSessions, railDirs, type RailDir } from "../list.ts";
import logoUrl from "../../assets/logo.png";

/** `/Users/me/Personal/Agentree` → `~/Personal/Agentree`; same for `C:\Users\me\…`. */
function tilde(p: string): string {
  const m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(p) ?? /^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/i.exec(p);
  return m ? "~" + (m[1] ?? "") : p;
}

/** Last segment of a POSIX or Windows path. */
const leaf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/**
 * One line per harness: what the last scan saw. A format change shows up here
 * as "files seen, few parsed" or as unknown record types the day it happens,
 * instead of as a list that is quietly missing conversations.
 */
function HealthRows({ health }: { health: ProviderHealth[] }) {
  const rows = health.filter((h) => h.present || h.error);
  if (rows.length === 0) return null;
  return (
    <div className="health muted small">
      {rows.map((h) => {
        const unknown = Object.entries(h.unknownRecordTypes);
        const versions = Object.entries(h.formatVersions)
          .map(([v, n]) => `${v} ×${n}`)
          .join(", ");
        const level = h.error ? "error" : h.warnings.length ? "warn" : "";
        return (
          <div
            key={h.provider}
            className={`health-row ${level}`}
            title={versions ? `${h.root}\n${versions}` : h.root}
          >
            <span className={`provider-chip ${h.provider}`}>{h.provider}</span>
            <span>
              {h.filesSeen} files · {h.sessionsParsed} parsed
              {h.skipped ? ` · ${h.skipped} hidden` : ""}
              {h.failed ? ` · ${h.failed} failed` : ""} · {h.listed} listed · {h.backend}
            </span>
            {unknown.length > 0 && (
              <details>
                <summary>· {unknown.length} unknown record types</summary>
                <code>{unknown.map(([t, n]) => `${t} ×${n}`).join(", ")}</code>
              </details>
            )}
            {h.error && <span>· {h.error}</span>}
            {h.warnings.map((w) => (
              <span key={w}>· {w}</span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The welcome screen is a picker, not a landing page: a directory rail on the
 * left, one flat list of conversations on the right, newest interaction first.
 *
 * No refresh button — the main process watches ~/.claude/projects and pushes
 * changes, so the list is already live. No "only branched" filter — the ⑂
 * badge on each row carries that signal without hiding anything.
 */
/** Rail rows shown before the rest collapses behind "more". */
const RAIL_DIRS = 10;

export function Welcome() {
  const { sessions, health, filter, cwdFilter, loading, update, openSession, set } = useStore();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const dirs = useMemo(() => railDirs(sessions), [sessions]);
  const visible = useMemo(
    () => filterSessions(sessions, { query: filter, cwd: cwdFilter }),
    [sessions, filter, cwdFilter],
  );
  const activeDir = dirs.find((d) => d.key === cwdFilter);

  return (
    <div className="welcome">
      <aside className="dir-rail">
        <div className="rail-brand">
          <img className="logo" src={logoUrl} alt="" width={40} height={40} />
          <div>
            <h1>Agentree</h1>
            <p className="muted small">conversation trees</p>
          </div>
        </div>

        <nav className="dir-list">
          <button
            className={`dir-row ${cwdFilter === "" ? "active" : ""}`}
            onClick={() => set({ cwdFilter: "" })}
          >
            <span className="dir-name">All conversations</span>
            <span className="dir-count">{sessions.length}</span>
          </button>

          <div className="rail-label muted small">recent directories</div>

          {(() => {
            const recent = dirs.slice(0, RAIL_DIRS);
            const rest = dirs.slice(RAIL_DIRS);
            // A selection from inside the collapsed set stays visible even
            // when the menu is shut — hiding the active filter would leave the
            // list narrowed with nothing in the rail saying why.
            const pinned =
              !moreOpen && cwdFilter && rest.some((d) => d.key === cwdFilter)
                ? rest.filter((d) => d.key === cwdFilter)
                : [];

            const row = ({ key, path, n }: RailDir) => (
              <button
                key={key}
                className={`dir-row ${cwdFilter === key ? "active" : ""}`}
                title={tilde(path)}
                onClick={() => set({ cwdFilter: key })}
              >
                <span className="dir-name">{leaf(path)}</span>
                <span className="dir-count">{n}</span>
              </button>
            );

            return (
              <>
                {recent.map(row)}
                {pinned.map(row)}
                {moreOpen && rest.map(row)}
                {rest.length > 0 && (
                  <button className="dir-row dir-more" onClick={() => setMoreOpen(!moreOpen)}>
                    <span className="dir-name muted">
                      {moreOpen ? "fewer directories" : "more directories…"}
                    </span>
                    {!moreOpen && <span className="dir-count">{rest.length}</span>}
                  </button>
                )}
              </>
            );
          })()}
        </nav>
      </aside>

      <main className="session-pane">
        {update && (
          <div className="update-banner">
            <span>
              A newer version of Agentree is available ({update.current} → {update.latest}).
              Update with <code>{update.command}</code>
            </span>
            <span className="update-actions">
              <button
                className="ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(update.command);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  } catch {
                    /* clipboard denied; the command is on screen to copy by hand */
                  }
                }}
              >
                {copied ? "✓ copied" : "copy command"}
              </button>
              <button className="ghost" onClick={() => set({ update: null })}>
                dismiss
              </button>
            </span>
          </div>
        )}
        <div className="session-pane-head">
          <input
            className="search"
            placeholder="Filter by title, directory, or id…"
            value={filter}
            onChange={(e) => set({ filter: e.target.value })}
          />
          <span className="muted small">
            {loading && sessions.length === 0 ? "scanning…" : `${visible.length} conversations`}
          </span>
        </div>

        <HealthRows health={health} />

        {cwdFilter && (
          <div className="active-dir muted small">
            <code>{tilde(activeDir?.path ?? cwdFilter)}</code>
            <button className="ghost" onClick={() => set({ cwdFilter: "" })}>
              show all
            </button>
          </div>
        )}

        <ul className="tree-list">
          {visible.map((s) => (
            <li key={`${s.provider}:${s.id}`}>
              <button className="tree-card" onClick={() => void openSession(s.id)}>
                <span className="tree-title">
                  <span className={`provider-chip ${s.provider}`}>{s.provider}</span>
                  {s.title}
                </span>
                <span className="muted small tree-sub">
                  {!cwdFilter && (
                    <>
                      <code className="cwd" title={s.cwd}>
                        {s.cwd ? tilde(s.cwd) : "(unknown directory)"}
                      </code>
                      {" · "}
                    </>
                  )}
                  {s.nodeCount} turns
                  {s.branchPoints > 0 && (
                    <span className="branch-badge" title="branch points">
                      ⑂ {s.branchPoints}
                    </span>
                  )}
                  {(s.members ?? 1) > 1 && (
                    <span className="fork-badge" title="sessions stitched into this tree (forks)">
                      {s.members} sessions
                    </span>
                  )}
                  {" · "}
                  <span title={`Last message or tool activity. Last file change: ${new Date(s.touchedAt).toLocaleString()}`}>
                    {when(s.activeAt)}
                  </span>
                  {" · "}
                  <code className="id-short">{s.id.slice(0, 8)}</code>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {!loading && visible.length === 0 && (
          <p className="muted empty">
            {sessions.length === 0
              ? "No agent sessions found in ~/.claude/projects, ~/.codex/sessions or ~/.copilot/session-state."
              : filter
                ? "Nothing matches that filter."
                : "No conversations in this directory yet."}
          </p>
        )}
      </main>
    </div>
  );
}
