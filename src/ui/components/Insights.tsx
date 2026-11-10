import { useMemo, useState, type ReactNode } from 'react';
import { categoryPath } from '../../domain/categories';
import { dateShort, kr } from '../../domain/format';
import { biggestExpense, monthlyRows, topExpenseCategories, type MonthRow } from '../../domain/monthly';
import type { Period } from '../../domain/types';
import { elapsedEnd } from '../../domain/periods';
import { useEngine } from '../../store/actions';
import { useStore } from '../../store/store';

const MONTH = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const mLabel = (m: string, withYear: boolean) => `${MONTH[Number(m.slice(5)) - 1]}${withYear ? ` ${m.slice(2, 4)}` : ''}`;
const krs = (v: number) => kr(v).replace(' kr', '');

/** Afrundede aksetrin (1, 2, 5 × 10^n) fra 0 (eller et negativt minimum) til maks. */
function ticks(min: number, max: number, n = 4) {
  const span = Math.max(1, max - min);
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * p).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

const W = 720, H = 220, PAD = { l: 56, r: 12, t: 12, b: 26 };

type Series = { key: string; label: string; color: string; values: number[] };

/** Søjler pr. måned – side om side (grouped), stablet (stacked) eller op/ned fra 0 (diverging, én serie). */
function MonthBars({ months, series, mode, withYear, tooltip }: {
  months: string[]; series: Series[]; mode: 'grouped' | 'stacked' | 'diverging'; withYear: boolean;
  tooltip: (i: number) => ReactNode;
}) {
  const [hover, setHover] = useState<number>();
  const totals = months.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.values[i]), 0));
  const all = series.flatMap((s) => s.values);
  const max = mode === 'stacked' ? Math.max(0, ...totals) : Math.max(0, ...all);
  const min = mode === 'diverging' ? Math.min(0, ...all) : 0;
  const tk = ticks(min, max);
  const y0 = tk[0], y1 = tk[tk.length - 1];
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const slot = iw / months.length;
  const groupW = Math.min(slot * 0.7, 56);
  const barW = mode === 'grouped' ? (groupW - 2 * (series.length - 1)) / series.length : groupW;
  const r = Math.min(4, barW / 2);
  /** Søjle med afrundede ender væk fra nul-linjen. */
  const bar = (x: number, from: number, to: number, color: string, round: boolean, key: string) => {
    const top = Math.min(y(from), y(to)), h = Math.abs(y(to) - y(from));
    if (h < 0.5) return null;
    const up = to >= from;
    const rr = round ? Math.min(r, h) : 0;
    const d = up
      ? `M${x},${top + h} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + barW - rr} Q${x + barW},${top} ${x + barW},${top + rr} V${top + h} Z`
      : `M${x},${top} V${top + h - rr} Q${x},${top + h} ${x + rr},${top + h} H${x + barW - rr} Q${x + barW},${top + h} ${x + barW},${top + h - rr} V${top} Z`;
    return <path key={key} d={d} fill={color} />;
  };
  return (
    <div className="viz-wrap" onMouseLeave={() => setHover(undefined)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="viz" role="img" aria-label={series.map((s) => s.label).join(', ')}>
        {tk.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className={v === 0 ? 'viz-zero' : 'viz-grid'} />
            <text x={PAD.l - 6} y={y(v) + 4} className="viz-tick" textAnchor="end">{krs(v)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = PAD.l + slot * i + slot / 2;
          const x0 = cx - groupW / 2;
          let acc = 0;
          const marks = series.map((s, j) => {
            const v = s.values[i];
            if (mode === 'stacked') {
              const from = acc; acc += Math.max(0, v);
              // 2px mellemrum mellem stablede felter; kun den øverste får afrundet ende.
              const isTop = series.slice(j + 1).every((x) => !(x.values[i] > 0));
              return bar(x0, from, Math.max(from, acc - (isTop ? 0 : (y1 - y0) * (2 / ih))), s.color, isTop, s.key);
            }
            const x = mode === 'grouped' ? x0 + j * (barW + 2) : x0;
            const color = mode === 'diverging' ? (v >= 0 ? 'var(--type-income)' : 'var(--type-expense)') : s.color;
            return bar(x, 0, v, color, true, s.key);
          });
          return (
            <g key={m}>
              {hover === i && <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={ih} className="viz-hover" />}
              {marks}
              <text x={cx} y={H - 8} className="viz-tick" textAnchor="middle">{mLabel(m, withYear)}</text>
              <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={mLabel(m, true)} />
            </g>
          );
        })}
      </svg>
      {hover !== undefined && (
        <div className="viz-tip" style={{ left: `${((PAD.l + slot * hover + slot / 2) / W) * 100}%` }}>
          <div className="viz-tip-title">{mLabel(months[hover], true)}</div>
          {tooltip(hover)}
        </div>
      )}
    </div>
  );
}

/** Nettoformue ved hver måneds udgang – linje med punkter og hover. */
function EquityLine({ months, values, start, withYear }: { months: string[]; values: number[]; start: number; withYear: boolean }) {
  const [hover, setHover] = useState<number>();
  const all = [start, ...values];
  const tk = ticks(Math.min(...all), Math.max(...all));
  const y0 = tk[0], y1 = tk[tk.length - 1];
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const slot = iw / months.length;
  const x = (i: number) => PAD.l + slot * i + slot / 2;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
  return (
    <div className="viz-wrap" onMouseLeave={() => setHover(undefined)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="viz" role="img" aria-label="Nettoformue ved månedens udgang">
        {tk.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className={v === 0 ? 'viz-zero' : 'viz-grid'} />
            <text x={PAD.l - 6} y={y(v) + 4} className="viz-tick" textAnchor="end">{krs(v)}</text>
          </g>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(start)} y2={y(start)} className="viz-ref" />
        <text x={W - PAD.r} y={y(start) - 4} className="viz-tick" textAnchor="end">primo</text>
        {hover !== undefined && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} className="viz-cross" />}
        <path d={d} className="viz-line" />
        {values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} className="viz-dot" />)}
        {months.map((m, i) => (
          <g key={m}>
            <text x={x(i)} y={H - 8} className="viz-tick" textAnchor="middle">{mLabel(m, withYear)}</text>
            <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} tabIndex={0} aria-label={mLabel(m, true)} onFocus={() => setHover(i)} />
          </g>
        ))}
      </svg>
      {hover !== undefined && (
        <div className="viz-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <div className="viz-tip-title">Ultimo {mLabel(months[hover], true)}</div>
          <div className="viz-tip-row"><span>Nettoformue</span><b>{kr(values[hover])}</b></div>
          <div className="viz-tip-row muted"><span>Siden primo</span><span>{values[hover] - start >= 0 ? '+' : '−'}{kr(Math.abs(values[hover] - start))}</span></div>
        </div>
      )}
    </div>
  );
}

const Legend = ({ items }: { items: { label: string; color: string }[] }) => (
  <div className="viz-legend">{items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}</div>
);

const Tile = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
  <div className="viz-tile"><div className="small ink2">{label}</div><div className="viz-tile-v">{value}</div>{sub && <div className="small muted">{sub}</div>}</div>
);

/** Nederst i regnskabet: periodens økonomi måned for måned. */
export function Insights({ period, equityOpen, result, incomeTotal, expenseTotal }: { period: Period; equityOpen: number; result: number; incomeTotal: number; expenseTotal: number }) {
  const e = useEngine();
  const showTx = useStore((s) => s.showTx);
  const [asTable, setAsTable] = useState(false);
  const rows: MonthRow[] = useMemo(() => monthlyRows(e.data.categories, e.ledger, period), [e, period]);
  if (rows.length < 2) return null;
  const months = rows.map((r) => r.month);
  const withYear = months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  const top = topExpenseCategories(rows, 5);
  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
  const catName = (id: string) => (id === 'uncat' ? 'Ukategoriseret' : categoryPath(e.data.categories, id) || id);
  const stacked: Series[] = [
    ...top.map((id, i) => ({ key: id, label: catName(id), color: SERIES[i], values: rows.map((r) => r.byCategory.get(id) ?? 0) })),
    { key: 'other', label: 'Andet', color: 'var(--series-other)', values: rows.map((r) => [...r.byCategory].filter(([k]) => !top.includes(k)).reduce((s, [, v]) => s + v, 0)) },
  ].filter((s) => s.values.some((v) => v > 0));

  // Dage, der er gået i perioden (et igangværende år tæller kun til i dag).
  const spentDays = Math.max(1, Math.round((Date.parse(elapsedEnd(period)) - Date.parse(period.start)) / 86400000) + 1);
  const dearest = rows.reduce((a, b) => (b.expense > a.expense ? b : a));
  const cheapest = rows.reduce((a, b) => (b.expense < a.expense ? b : a));
  const big = biggestExpense(e.data.txs, period, (t) => !!e.resolved.get(t.id)?.lines.some((l) => l.type === 'expense'));
  const savings = incomeTotal > 0 ? result / incomeTotal : undefined;
  const plusMonths = rows.filter((r) => r.net >= 0).length;

  return (
    <section className="fs-card viz-root">
      <h2 className="fs-title">Indsigter</h2>
      <div className="viz-tiles">
        <Tile label="Opsparingsrate" value={savings === undefined ? '–' : `${Math.round(savings * 100)} %`} sub="af indtægterne blev til overskud" />
        <Tile label="Forbrug pr. dag" value={kr(Math.round(expenseTotal / spentDays))} sub={`gennemsnit over ${spentDays} dage`} />
        <Tile label="Dyreste måned" value={mLabel(dearest.month, true)} sub={`${kr(dearest.expense)} · billigst: ${mLabel(cheapest.month, false)} ${kr(cheapest.expense)}`} />
        <Tile label="Måneder med overskud" value={`${plusMonths} af ${rows.length}`} />
        {big && <Tile label="Største enkeltudgift" value={kr(-big.amount)} sub={<button className="linkish" onClick={() => showTx(big.id)}>{dateShort(big.date)} {big.text}</button>} />}
      </div>

      <div className="viz-grid2">
        <div>
          <h3 className="viz-title">Indtægter og udgifter pr. måned</h3>
          <Legend items={[{ label: 'Indtægter', color: 'var(--type-income)' }, { label: 'Udgifter', color: 'var(--type-expense)' }]} />
          <MonthBars months={months} withYear={withYear} mode="grouped"
            series={[{ key: 'inc', label: 'Indtægter', color: 'var(--type-income)', values: rows.map((r) => r.income) }, { key: 'exp', label: 'Udgifter', color: 'var(--type-expense)', values: rows.map((r) => r.expense) }]}
            tooltip={(i) => (
              <>
                <div className="viz-tip-row"><span><i style={{ background: 'var(--type-income)' }} />Indtægter</span><b>{kr(rows[i].income)}</b></div>
                <div className="viz-tip-row"><span><i style={{ background: 'var(--type-expense)' }} />Udgifter</span><b>{kr(rows[i].expense)}</b></div>
                <div className="viz-tip-row sep"><span>Resultat</span><b>{rows[i].net >= 0 ? '+' : '−'}{kr(Math.abs(rows[i].net))}</b></div>
              </>
            )} />
        </div>
        <div>
          <h3 className="viz-title">Månedens resultat</h3>
          <Legend items={[{ label: 'Overskud', color: 'var(--type-income)' }, { label: 'Underskud', color: 'var(--type-expense)' }]} />
          <MonthBars months={months} withYear={withYear} mode="diverging"
            series={[{ key: 'net', label: 'Resultat', color: 'var(--type-income)', values: rows.map((r) => r.net) }]}
            tooltip={(i) => <div className="viz-tip-row"><span>{rows[i].net >= 0 ? 'Overskud' : 'Underskud'}</span><b>{kr(Math.abs(rows[i].net))}</b></div>} />
        </div>
        <div>
          <h3 className="viz-title">Nettoformue gennem perioden</h3>
          <div className="viz-legend"><span className="muted">Primo {kr(equityOpen)} · ultimo {kr(rows[rows.length - 1].equity)}</span></div>
          <EquityLine months={months} withYear={withYear} values={rows.map((r) => r.equity)} start={equityOpen} />
        </div>
        <div>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h3 className="viz-title grow">Udgifter pr. kategori pr. måned</h3>
            <button className="btn sm ghost" onClick={() => setAsTable(!asTable)}>{asTable ? 'Vis som graf' : 'Vis som tabel'}</button>
          </div>
          <Legend items={stacked.map((s) => ({ label: s.label, color: s.color }))} />
          {asTable ? (
            <div className="table-wrap">
              <table className="small viz-table">
                <thead><tr><th>Kategori</th>{months.map((m) => <th key={m} className="num">{mLabel(m, withYear)}</th>)}<th className="num">I alt</th></tr></thead>
                <tbody>
                  {stacked.map((s) => (
                    <tr key={s.key}><td><i className="viz-swatch" style={{ background: s.color }} />{s.label}</td>{s.values.map((v, i) => <td key={i} className="num">{v ? krs(v) : '–'}</td>)}<td className="num"><b>{krs(s.values.reduce((a, b) => a + b, 0))}</b></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <MonthBars months={months} withYear={withYear} mode="stacked" series={stacked}
              tooltip={(i) => (
                <>
                  {[...stacked].reverse().filter((s) => s.values[i] > 0).map((s) => (
                    <div key={s.key} className="viz-tip-row"><span><i style={{ background: s.color }} />{s.label}</span><b>{kr(s.values[i])}</b></div>
                  ))}
                  <div className="viz-tip-row sep"><span>Udgifter i alt</span><b>{kr(rows[i].expense)}</b></div>
                </>
              )} />
          )}
        </div>
      </div>
    </section>
  );
}
