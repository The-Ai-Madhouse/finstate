import { useState, type ReactNode } from 'react';
import { kr } from '../../domain/format';

function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; c: ReactNode } | null>(null);
  const el = tip && (
    <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 10 }}>{tip.c}</div>
  );
  return { el, show: (e: React.MouseEvent, c: ReactNode) => setTip({ x: e.clientX, y: e.clientY, c }), hide: () => setTip(null) };
}

/** Runder kun data-enden (væk fra nul-linjen). */
function barPath(x0: number, x1: number, y: number, h: number, r = 4) {
  const w = x1 - x0;
  if (w <= 0) return '';
  const rr = Math.min(r, w, h / 2);
  return `M${x0},${y} H${x1 - rr} Q${x1},${y} ${x1},${y + rr} V${y + h - rr} Q${x1},${y + h} ${x1 - rr},${y + h} H${x0} Z`;
}

export interface BarRow { label: string; now: number; prev?: number }

/** Vandrette søjler: denne periode vs. forrige. Beløb i øre (positive). */
export function BarCompare({ rows, nowLabel, prevLabel, labelWidth = 150, rowH = 30 }: {
  rows: BarRow[];
  nowLabel: string;
  prevLabel?: string;
  labelWidth?: number;
  rowH?: number;
}) {
  const { el, show, hide } = useTip();
  const hasPrev = !!prevLabel && rows.some((r) => r.prev);
  const max = Math.max(1, ...rows.flatMap((r) => [r.now, r.prev ?? 0]));
  const W = 640, valW = 80, plotW = W - labelWidth - valW;
  const H = rows.length * rowH + 8;
  const sx = (v: number) => labelWidth + (Math.max(0, v) / max) * plotW;
  const bh = hasPrev ? (rowH - 10) / 2 : rowH - 12;
  return (
    <div>
      {hasPrev && (
        <div className="legend" style={{ marginBottom: 6 }}>
          <span><i className="dot" style={{ background: 'var(--s1)' }} />{nowLabel}</span>
          <span><i className="dot" style={{ background: 'var(--s2)' }} />{prevLabel}</span>
        </div>
      )}
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Søjlediagram: ${rows.map((r) => `${r.label} ${kr(r.now)}`).join(', ')}`}>
        <line className="axis" x1={labelWidth} x2={labelWidth} y1={0} y2={H - 4} />
        {rows.map((r, i) => {
          const y = i * rowH + 4;
          const tipC = (
            <div>
              <b>{r.label}</b>
              <div>{nowLabel}: {kr(r.now)}</div>
              {hasPrev && <div className="muted">{prevLabel}: {kr(r.prev ?? 0)}</div>}
            </div>
          );
          return (
            <g key={r.label + i} onMouseMove={(e) => show(e, tipC)} onMouseLeave={hide}>
              <rect x={0} y={y - 2} width={W} height={rowH} fill="transparent" />
              <text x={labelWidth - 8} y={y + rowH / 2 - 1} textAnchor="end" dominantBaseline="middle">
                {r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label}
              </text>
              <path d={barPath(labelWidth, sx(r.now), y, bh)} fill="var(--s1)" />
              {hasPrev && <path d={barPath(labelWidth, sx(r.prev ?? 0), y + bh + 2, bh)} fill="var(--s2)" />}
              <text x={sx(r.now) + 6} y={y + bh / 2} dominantBaseline="middle" style={{ fill: 'var(--ink)' }}>{kr(r.now)}</text>
            </g>
          );
        })}
      </svg>
      {el}
    </div>
  );
}

/** Linje over tid (fx nettoformue pr. periodeafslutning). */
export function TrendLine({ points, height = 220 }: { points: { label: string; value: number }[]; height?: number }) {
  const { el, show, hide } = useTip();
  if (points.length < 2) return <div className="muted small">Kræver mindst to perioder.</div>;
  const W = 640, H = height, pl = 70, pr = 20, pt = 16, pb = 28;
  const vals = points.map((p) => p.value);
  let lo = Math.min(0, ...vals), hi = Math.max(...vals);
  if (hi === lo) hi = lo + 100;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const sx = (i: number) => pl + (i / (points.length - 1)) * (W - pl - pr);
  const sy = (v: number) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1; v += step) ticks.push(v);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(i)},${sy(p.value)}`).join(' ');
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={points.map((p) => `${p.label}: ${kr(p.value)}`).join(', ')}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={pl} x2={W - pr} y1={sy(t)} y2={sy(t)} />
            <text x={pl - 8} y={sy(t)} textAnchor="end" dominantBaseline="middle">{kr(t)}</text>
          </g>
        ))}
        <path d={d} fill="none" stroke="var(--s1)" strokeWidth={2} strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={i} onMouseMove={(e) => show(e, <div><b>{p.label}</b><div>{kr(p.value)}</div></div>)} onMouseLeave={hide}>
            <circle cx={sx(i)} cy={sy(p.value)} r={14} fill="transparent" />
            <circle cx={sx(i)} cy={sy(p.value)} r={4.5} fill="var(--s1)" stroke="var(--surface)" strokeWidth={2} />
            <text x={sx(i)} y={H - 8} textAnchor="middle">{p.label}</text>
          </g>
        ))}
        <text x={sx(points.length - 1)} y={sy(points[points.length - 1].value) - 12} textAnchor="end" style={{ fill: 'var(--ink)', fontWeight: 600 }}>
          {kr(points[points.length - 1].value)}
        </text>
      </svg>
      {el}
    </div>
  );
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
