export function usd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function ms(n: number | undefined): string {
  if (n == null) return "—";
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function when(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** `/Users/me/Personal/Agentree` → `~/Personal/Agentree`; same for `C:\Users\me\…`. */
export function tilde(p: string): string {
  const m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(p) ?? /^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/i.exec(p);
  return m ? "~" + (m[1] ?? "") : p;
}

/** A path's last folder: `C:\src\Agentree\` → `Agentree`. A bare root stays as it is. */
export function folderOf(p: string): string {
  const parts = p.trim().split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p.trim();
}

/** "1h 40m", "25m", "45s": a stretch of time, coarsely. */
export function span(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
