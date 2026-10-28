import { useStore } from "../store.ts";
import { dayKeyOf, dayTitle, shortDay } from "../day.ts";
import { refOf } from "../../shared/render.ts";
import logoUrl from "../../assets/logo.png";

export function Toolbar() {
  const { session, compress, set, close, selected, nodes, showInDay } = useStore();
  if (!session) return null;
  // The selected turn's day, with every other chat of that day around it.
  const node = selected ? nodes.get(selected) : undefined;
  const day = node && node.timestamp > 0 ? dayKeyOf(node.timestamp) : null;

  return (
    <header className="toolbar">
      <button className="ghost" onClick={close} title="Back to all sessions (Esc)">
        ←
      </button>
      <img className="mark" src={logoUrl} alt="" width={20} height={20} />
      <span className="tree-name" title={session.meta.title}>
        {session.meta.title}
      </span>
      <span className="muted small">{session.meta.project}</span>
      <span className="muted small">
        {session.meta.nodeCount} turns · {session.meta.branchPoints} branch
        {session.meta.branchPoints === 1 ? "" : "es"}
      </span>

      <span className="spacer" />

      <button
        className="ghost"
        disabled={!day}
        title={day ? `Show the selected turn in the day view of ${dayTitle(day)}, among every chat that day` : "The selected turn has no time"}
        onClick={() => node && day && void showInDay(day, { provider: session.meta.provider, ref: refOf(node) })}
      >
        ◷ {day ? shortDay(day) : "day"}
      </button>

      <label className="ctl" title="Collapse runs of linear turns into a single element">
        <input
          type="checkbox"
          checked={compress}
          onChange={(e) => set({ compress: e.target.checked })}
        />
        <span className="small">compress chains</span>
      </label>

    </header>
  );
}
