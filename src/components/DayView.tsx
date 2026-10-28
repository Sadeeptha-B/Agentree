import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { span, tilde } from "../format.ts";
import { useCanvasWheel } from "../wheel.ts";
import { endOf } from "../../shared/render.ts";
import { chatName, clock, dayTitle, filterDay, isDayKey, latestActiveDay, shiftDay, todayKey } from "../day.ts";
import {
  buildDayLayout, dotRadius, LABEL_W, laneLatest, PAD, stepInLane, stepLane, visibleTicks,
  type DayDot, type DayEdge, type DayLane, type DayLayout,
} from "../day-layout.ts";
import type { ProviderId } from "../../shared/types.ts";

/**
 * The viewport. Zoom is time-only: layout x maps to `tx + x * k` on screen,
 * layout y to `ty + y` — lanes keep their height, so names and time labels
 * stay readable at any zoom.
 */
interface View {
  tx: number;
  ty: number;
  k: number;
}

/** The layout → screen mapping of a view. */
const screen = (v: View) => ({ x: (x: number) => v.tx + x * v.k, y: (y: number) => v.ty + y });
type Screen = ReturnType<typeof screen>;

/** Height of the time-label strip pinned along the top: lanes scroll under it. */
const AXIS_STRIP = 22;

const PROVIDERS: ProviderId[] = ["claude", "codex", "copilot"];

function edgePath(e: DayEdge, s: Screen, r: number): string {
  const bx = s.x(e.to.x);
  const by = s.y(e.to.y);
  if (e.kind === "lead") return `M${bx - 26},${by} L${bx - r - 2},${by}`;
  const ax = s.x(e.from.x);
  const ay = s.y(e.from.y);
  if (ay === by) return `M${ax},${ay} L${bx},${by}`;
  const mx = ax + Math.max(12, (bx - ax) / 2);
  return `M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}`;
}

/**
 * The day view: every chat's turns of one local day on a shared, compressed
 * time axis (`day-layout.ts`), one lane per chat session, colored by agent.
 * A turn opens in its family's tree, focused on its chat.
 */
export function DayView() {
  const {
    day, dayActivity, dayLoading, daySelected, sessions, filter, cwdFilter, providerFilter, settingsRev,
    setDay, loadDay, set, openSession,
  } = useStore();

  useEffect(() => {
    void loadDay();
  }, [day, settingsRev, loadDay]);

  const shown = useMemo(
    () => (dayActivity ? filterDay(dayActivity, { query: filter, cwd: cwdFilter, provider: providerFilter }) : null),
    [dayActivity, filter, cwdFilter, providerFilter],
  );
  const layout = useMemo(() => (shown ? buildDayLayout(shown.turns, shown.chats, shown.running) : null), [shown]);
  const selected = (daySelected && layout?.byKey.get(daySelected)) || null;
  const select = (key: string | null) => set({ daySelected: key });
  const open = (d: DayDot) =>
    void openSession(d.turn.familyId, { focus: d.turn.sessionId, select: d.turn.ref });

  const svgRef = useRef<SVGSVGElement | null>(null);
  // The timeline is the keyboard's target: picking a chat or a turn from a
  // button moves focus here, so Enter opens the turn instead of pressing the
  // button again.
  const timelineRef = useRef<HTMLDivElement>(null);
  // A viewport kept from before a tree was opened from this day: Esc comes
  // back to the same place, not to a fresh fit.
  const kept = useStore.getState().dayViewport;
  const restored = kept?.day === day ? kept : null;
  const [view, setView] = useState<View>(restored ?? { tx: LABEL_W, ty: 0, k: 1 });
  const [hover, setHover] = useState<DayDot | null>(null);
  const [hoverLane, setHoverLane] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Fit: the whole day. `readable` fits only the day's length, and no
  // smaller than legible: from the first chat down, scrolled to the latest
  // turns — where a day that is still going is happening.
  const fitRef = useRef<(readable?: boolean) => void>(() => {});
  fitRef.current = (readable) => {
    const el = svgRef.current;
    if (!el || !layout || layout.dots.length === 0) return;
    const w = el.getBoundingClientRect().width;
    const room = Math.max(80, w - LABEL_W);
    const k = readable ? Math.min(1, Math.max(0.6, room / layout.width)) : Math.min(room / layout.width, 1.4);
    const tx = layout.width * k <= room ? LABEL_W : w - layout.width * k;
    setView({ tx, ty: 0, k });
  };

  // Once per loaded day (not per refresh): after that the viewport is the
  // user's. A selection kept from earlier is brought into view.
  const fitted = useRef<string | null>(restored ? day : null);
  useEffect(() => {
    if (!layout || layout.dots.length === 0 || fitted.current === day) return;
    fitted.current = day;
    fitRef.current(true);
    revealRef.current(useStore.getState().daySelected);
  }, [layout, day]);

  // Kept for the way back from a tree (the view unmounts while it is open).
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    return () => useStore.getState().set({ dayViewport: { day: useStore.getState().day, ...viewRef.current } });
  }, []);

  // Keep the selection in view when the keyboard moves it.
  const revealRef = useRef<(key: string | null) => void>(() => {});
  const reveal = (revealRef.current = (key: string | null) => {
    const d = key && layout?.byKey.get(key);
    const el = svgRef.current;
    if (!d || !el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    setView((v) => {
      const sx = screen(v).x(d.x);
      const sy = screen(v).y(d.y);
      let { tx, ty } = v;
      if (sx < LABEL_W + 30) tx += LABEL_W + 30 - sx;
      else if (sx > w - 30) tx -= sx - (w - 30);
      if (sy < AXIS_STRIP + 16) ty += AXIS_STRIP + 16 - sy;
      else if (sy > h - 40) ty -= sy - (h - 40);
      return { ...v, tx, ty };
    });
  });

  /** Select a turn (or none) from anywhere — a key, a lane, the card — and keep it in view and in focus. */
  const pick = (key: string | null) => {
    select(key);
    reveal(key);
    timelineRef.current?.focus({ preventScroll: true });
  };

  // Arrows walk the day: ←/→ within the chat, ↑/↓ to the chat above or below
  // (its turn nearest in time); Enter opens the selected turn in its tree.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && e.key !== "Escape") return;
    // Nothing behind an open dialog reacts to its keys. (Settings also keeps
    // its keys and its focus to itself; this holds whatever has focus.)
    if (useStore.getState().settingsOpen) return;
    if (!layout || layout.dots.length === 0) return;
    let next: string | null = null;
    const cur = selected?.key;
    // Enter on a focused button is that button's click.
    if (e.key === "Enter" && selected && t?.tagName !== "BUTTON") {
      e.preventDefault();
      open(selected);
      return;
    }
    if (e.key === "Escape" && selected) {
      select(null);
      return;
    }
    if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
    e.preventDefault();
    if (!cur) next = layout.dots[layout.dots.length - 1].key;
    else if (e.key === "ArrowLeft") next = stepInLane(layout, cur, -1);
    else if (e.key === "ArrowRight") next = stepInLane(layout, cur, 1);
    else if (e.key === "ArrowUp") next = stepLane(layout, cur, -1);
    else next = stepLane(layout, cur, 1);
    if (next) pick(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- pan & zoom (as in the tree); a sideways scroll pans along the day.
  const wheelRef = useCanvasWheel<SVGSVGElement>((e, el) => {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      setView((v) => ({ ...v, tx: v.tx - dx }));
      return;
    }
    // Zoom the time axis about the pointer; the lanes don't scale.
    const px = e.clientX - el.getBoundingClientRect().left;
    const factor = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const k = Math.min(4, Math.max(0.03, v.k * factor));
      return { ...v, k, tx: px - ((px - v.tx) * k) / v.k };
    });
  });
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const today = todayKey();
  const latest = latestActiveDay(sessions);
  const providersShown = PROVIDERS.filter((p) => shown?.chats.some((c) => c.provider === p));
  const hasCross = !!layout?.edges.some((e) => e.cross);

  return (
    <div className="day">
      <div className="day-head">
        <button className="ghost" title="Previous day" onClick={() => setDay(shiftDay(day, -1))}>
          ◀
        </button>
        <input
          className="day-date"
          type="date"
          value={day}
          max={today}
          onChange={(e) => isDayKey(e.target.value) && setDay(e.target.value)}
        />
        <button className="ghost" title="Next day" disabled={day >= today} onClick={() => setDay(shiftDay(day, 1))}>
          ▶
        </button>
        <button className="ghost" disabled={day === today} onClick={() => setDay(today)}>
          today
        </button>
        <span className="day-title">{dayTitle(day)}</span>
        <span className="muted small">
          {shown
            ? `${shown.turns.length} turns · ${layout?.lanes.length ?? 0} chat${layout?.lanes.length === 1 ? "" : "s"}`
            : "loading day…"}
          {dayLoading && shown ? " · refreshing…" : ""}
        </span>
      </div>

      <div className="day-body">
        {!layout || layout.dots.length === 0 ? (
          <div className="canvas empty day-canvas">
            {!layout ? (
              <p className="muted">loading day…</p>
            ) : (
              <div className="empty-day">
                <p className="muted">
                  {dayActivity && dayActivity.turns.length > 0
                    ? `Nothing on ${dayTitle(day)} matches the filters.`
                    : `No activity on ${dayTitle(day)}.`}
                </p>
                {latest && latest !== day && (
                  <button className="ghost bordered" onClick={() => setDay(latest)}>
                    go to the latest activity · {dayTitle(latest)}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div
            className="canvas day-canvas"
            ref={timelineRef}
            tabIndex={0}
            aria-label="Day timeline: arrow keys move between turns and chats, Enter opens the selected turn"
          >
            <div className="canvas-tools day-tools">
              <button className="ghost" onClick={() => fitRef.current(false)} title="Fit the whole day to the view">
                fit
              </button>
              <button className="ghost" onClick={() => fitRef.current(true)} title="Readable size, at the latest turns">
                latest
              </button>
              <button className="ghost" onClick={() => setView((v) => ({ ...v, k: v.k * 1.25 }))}>
                +
              </button>
              <button className="ghost" onClick={() => setView((v) => ({ ...v, k: v.k / 1.25 }))}>
                −
              </button>
              <span className="muted small">{Math.round(view.k * 100)}%</span>
            </div>

            <svg
              ref={(el) => {
                svgRef.current = el;
                wheelRef(el);
              }}
              className="tree-svg"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerLeave={endDrag}
            >
              <DayGrid
                layout={layout}
                s={screen(view)}
                k={view.k}
                hoverLane={hoverLane}
                selectedLane={selected?.lane ?? null}
              />
              <g className="edges">
                {layout.edges.map((e) => (
                  <path
                    key={`${e.kind}:${e.to.key}`}
                    d={edgePath(e, screen(view), dotRadius(view.k))}
                    className={`edge ${e.cross ? "cross" : ""} ${e.kind === "lead" ? "lead" : ""} ${
                      selected && e.to.lane === selected.lane ? "on-path" : ""
                    }`}
                  />
                ))}
              </g>
              <g className="nodes">
                {layout.dots.map((d) => (
                  <Dot
                    key={d.key}
                    d={d}
                    at={[screen(view).x(d.x), screen(view).y(d.y)]}
                    r={dotRadius(view.k)}
                    isSelected={d.key === selected?.key}
                    onSelect={() => select(d.key)}
                    onOpen={() => open(d)}
                    onHover={(on) => {
                      setHover(on ? d : null);
                      setHoverLane(on ? d.lane : null);
                    }}
                  />
                ))}
              </g>
              <TimeLabels layout={layout} s={screen(view)} k={view.k} />
            </svg>

            <LaneLabels
              lanes={layout.lanes}
              view={view}
              selectedLane={selected?.lane ?? null}
              onPick={(lane) => pick(laneLatest(layout, lane)?.key ?? null)}
              onHover={setHoverLane}
            />

            {hover && (
              <div className="tree-tooltip">
                {clock(hover.turn.timestamp)} · {hover.turn.midTurn ? "mid-turn " : ""}
                {hover.turn.role}: {hover.turn.preview.slice(0, 120)}
              </div>
            )}

            <div className={`legend muted small ${hover ? "legend-hidden" : ""}`}>
              {providersShown.map((p) => (
                <span key={p}>
                  <i className={`lg-dot lg-p ${p}`} /> {p}
                </span>
              ))}
              <span>
                <i className="lg-dot lg-filled" /> you
              </span>
              <span>
                <i className="lg-dot lg-ring" /> agent
              </span>
              {hasCross && (
                <span title="The dashed edge enters a fork (a new session), or a Codex prompt edit">
                  <i className="lg-cross" /> fork / edited branch
                </span>
              )}
              <span title="A pause of 20 minutes or more, drawn short">
                <i className="lg-break" /> idle
              </span>
            </div>
          </div>
        )}

        <DayCard
          layout={layout}
          selected={selected}
          onPick={pick}
          onOpen={open}
        />
      </div>
    </div>
  );
}

/** Lane stripes, family separators, hour lines and idle breaks: everything behind the turns. */
function DayGrid({
  layout,
  s,
  k,
  hoverLane,
  selectedLane,
}: {
  layout: DayLayout;
  s: Screen;
  k: number;
  hoverLane: number | null;
  selectedLane: number | null;
}) {
  const { lanes, breaks, height } = layout;
  const ticks = visibleTicks(layout.ticks, k);
  const bottom = s.y(height - PAD);
  const inset = dotRadius(k) + 6;
  return (
    <g className="day-grid">
      {lanes.map((l, i) => (
        <g key={l.key}>
          <rect
            className={`day-lane ${i % 2 ? "odd" : ""} ${i === hoverLane ? "hover" : ""} ${
              i === selectedLane ? "selected" : ""
            }`}
            x={0}
            y={s.y(l.top)}
            width="100%"
            height={l.height}
          />
          <rect className={`day-lane-bar ${l.chat.provider}`} x={LABEL_W} y={s.y(l.top) + 3} width={3} height={l.height - 6} />
          {l.familyStart && i > 0 && (
            <line className="day-family-sep" x1={0} x2="100%" y1={s.y(l.top) - 5} y2={s.y(l.top) - 5} />
          )}
        </g>
      ))}
      {ticks.map((t) => (
        <line key={`${t.kind}:${t.t}`} className={`day-tick ${t.kind}`} x1={s.x(t.x)} x2={s.x(t.x)} y1={AXIS_STRIP} y2={bottom} />
      ))}
      {breaks.map((b) => (
        <g key={`${b.x0}:${b.x1}`} className="day-break">
          <rect
            x={s.x(b.x0) + inset}
            y={AXIS_STRIP}
            width={Math.max(0, (b.x1 - b.x0) * k - 2 * inset)}
            height={Math.max(0, bottom - AXIS_STRIP)}
          />
          <text x={s.x((b.x0 + b.x1) / 2)} y={bottom + 14}>
            {span(b.ms)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** The time labels, pinned along the top over an opaque strip: the lanes scroll under them. */
function TimeLabels({ layout, s, k }: { layout: DayLayout; s: Screen; k: number }) {
  return (
    <g className="day-axis">
      <rect className="day-axis-strip" x={0} y={0} width="100%" height={AXIS_STRIP} />
      {visibleTicks(layout.ticks, k).map((t) => (
        <text key={`${t.kind}:${t.t}`} className={`day-tick ${t.kind}`} x={s.x(t.x)} y={AXIS_STRIP - 7}>
          {clock(t.t)}
        </text>
      ))}
    </g>
  );
}

function Dot({
  d,
  at,
  r,
  isSelected,
  onSelect,
  onOpen,
  onHover,
}: {
  d: DayDot;
  /** Where it is drawn, on screen. */
  at: [number, number];
  r: number;
  isSelected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onHover: (on: boolean) => void;
}) {
  const t = d.turn;
  return (
    <g
      className={[
        "day-dot",
        t.provider,
        t.role,
        t.isSidechain ? "sidechain" : "",
        t.midTurn ? "mid" : "",
        isSelected ? "selected" : "",
      ].join(" ")}
      transform={`translate(${at[0]},${at[1]})`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {isSelected && <circle r={r + 5} className="halo" />}
      <circle r={t.role === "user" ? r : Math.max(1.5, r - 1)} className="mark" />
    </g>
  );
}

/**
 * Chat names, pinned at the left edge, wrapped whole: they follow the
 * vertical pan only. Each lane is as tall as its name needs (`labelLines`).
 */
function LaneLabels({
  lanes,
  view,
  selectedLane,
  onPick,
  onHover,
}: {
  lanes: DayLane[];
  view: View;
  selectedLane: number | null;
  onPick: (lane: DayLane) => void;
  onHover: (lane: number | null) => void;
}) {
  return (
    <div className="day-labels" style={{ width: LABEL_W, top: AXIS_STRIP }}>
      {lanes.map((l, i) => {
        const fork = l.chat.parentSessionId !== null;
        return (
          <button
            key={l.key}
            className={`day-label ${i === selectedLane ? "selected" : ""}`}
            style={{ top: screen(view).y(l.top) - AXIS_STRIP, height: l.height }}
            title={`${l.chat.title}${fork ? ` · forked from “${l.chat.parentTitle ?? l.chat.familyTitle}”` : ""}
${tilde(l.chat.cwd)}
${l.turns.length} turns this day — click for the latest`}
            onClick={() => onPick(l)}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
          >
            <span className={`day-label-dot ${l.chat.provider}`} />
            {fork && <span className="fork-glyph">⑂</span>}
            <span className="day-label-name">{chatName(l.chat)}</span>
            <span className="dir-count">{l.turns.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The side card: the selected turn — its chat, time and text, and the way
 * into its tree — or, with nothing selected, the day's chats to pick from.
 */
function DayCard({
  layout,
  selected,
  onPick,
  onOpen,
}: {
  layout: DayLayout | null;
  selected: DayDot | null;
  onPick: (key: string | null) => void;
  onOpen: (d: DayDot) => void;
}) {
  if (!layout || layout.dots.length === 0) return null;
  if (!selected) {
    return (
      <aside className="day-card">
        <h3>Chats this day</h3>
        <ul className="day-chats">
          {layout.lanes.map((l) => (
            <li key={l.key}>
              <button className="day-chat" onClick={() => onPick(laneLatest(layout, l)?.key ?? null)}>
                <span className="day-chat-name">
                  <span className={`provider-chip ${l.chat.provider}`}>{l.chat.provider}</span>
                  <span>
                    {l.chat.parentSessionId && <span className="fork-glyph">⑂</span>}
                    {chatName(l.chat)}
                  </span>
                </span>
                <span className="muted small">
                  {l.turns.length} turns · {clock(layout.byKey.get(l.turns[0])!.turn.timestamp)}–
                  {clock(endOf(laneLatest(layout, l)!.turn))}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small hint">Click a turn, or use the arrow keys: ←/→ within a chat, ↑/↓ between chats.</p>
      </aside>
    );
  }

  const t = selected.turn;
  const chat = layout.lanes[selected.lane].chat;
  const prev = stepInLane(layout, selected.key, -1);
  const next = stepInLane(layout, selected.key, 1);
  return (
    <aside className="day-card">
      <button className="ghost day-back" onClick={() => onPick(null)}>
        ← all chats
      </button>
      <div className="day-card-chat">
        <span className={`provider-chip ${chat.provider}`}>{chat.provider}</span>
        <strong>{chat.title}</strong>
      </div>
      {chat.parentSessionId && (
        <div className="muted small">
          {chat.parentEvidence === "inferred" ? "probably forked from" : "forked from"} “{chat.parentTitle ?? chat.familyTitle}”
        </div>
      )}
      <code className="path">{chat.cwd ? tilde(chat.cwd) : "(unknown directory)"}</code>
      <div className="day-card-meta small">
        <span className={`role ${t.role}`}>{t.midTurn ? "mid-turn " : ""}{t.role === "user" ? "you" : "agent"}</span>
        {" · "}
        {clock(t.timestamp)}
        {t.endedAt ? `–${clock(t.endedAt)}` : ""}
        {t.branchKind === "fork" ? " · starts the fork" : t.branchKind === "edit" ? " · edited prompt" : ""}
        {t.isSidechain ? " · subagent" : ""}
      </div>
      <div className="day-card-text">{t.preview}</div>
      <div className="panel-actions day-card-actions">
        <button className="ghost" onClick={() => onOpen(selected)} title="Open this chat's tree on this turn (Enter)">
          open in tree ↵
        </button>
        <button className="ghost" disabled={!prev} onClick={() => onPick(prev)} title="Previous turn in this chat (←)">
          ←
        </button>
        <button className="ghost" disabled={!next} onClick={() => onPick(next)} title="Next turn in this chat (→)">
          →
        </button>
      </div>
    </aside>
  );
}
