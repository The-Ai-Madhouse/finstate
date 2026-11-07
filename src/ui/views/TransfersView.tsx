import { NoPeriod } from '../components/PeriodPrompt';
import { useState } from 'react';
import { inPeriod } from '../../domain/engine';
import { dateShort, kr } from '../../domain/format';
import type { Tx } from '../../domain/types';
import { dayDiff } from '../../domain/util';
import { setManual, useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { Empty, Money } from '../components/common';
import { SettleOverview } from '../components/SettlePanel';

export function TransfersView() {
  const period = usePeriod();
  if (!period) return <NoPeriod />;
  return (
    <div className="stack">
      <h1>Overførsler</h1>
      <Internal />
      <SettleOverview />
    </div>
  );
}

function Internal() {
  const e = useEngine();
  const period = usePeriod()!;
  const { data } = e;
  const acc = (id?: string) => data.accounts.find((a) => a.id === id);
  const internal = data.txs
    .filter((t) => inPeriod(t, period) && t.date > data.settings.bookStart)
    .filter((t) => e.resolved.get(t.id)!.lines.some((l) => l.type === 'internal'))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const st = e.statement(period);
  const transit = st.rows.find((r) => r.ref === 'transit');
  const [showPaired, setShowPaired] = useState(false);

  const rows = internal.map((t) => {
    const r = e.resolved.get(t.id)!;
    const target = acc(r.lines[0].targetAccountId);
    const pair = r.pairId ? e.txById.get(r.pairId) : undefined;
    let candidates: Tx[] = [];
    if (!pair && (!target || target.kind === 'bank')) {
      candidates = data.txs
        .filter((o) => o.accountId !== t.accountId && o.amount === -t.amount && Math.abs(dayDiff(t.date, o.date)) <= 45 && !e.resolved.get(o.id)!.pairId)
        .sort((a, b) => Math.abs(dayDiff(t.date, a.date)) - Math.abs(dayDiff(t.date, b.date)))
        .slice(0, 2);
    }
    return { t, r, target, pair, candidates };
  });
  const unpaired = rows.filter((x) => !x.pair && (!x.target || x.target.kind === 'bank'));
  const shown = showPaired ? rows : unpaired;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Interne overførsler</h2>
        <span className="spacer" />
        <span className="chip">{rows.length - unpaired.length} parret</span>
        <span className={`chip ${unpaired.length ? 'review' : 'user'}`}>{unpaired.length} uden modpost</span>
        <label className="row small ink2"><input type="checkbox" checked={showPaired} onChange={(ev) => setShowPaired(ev.target.checked)} /> Vis parrede</label>
      </div>
      <p className="ink2 small" style={{ marginBottom: 10 }}>
        Interne overførsler flytter kun penge mellem aktiver. Hvis modposten først bogføres i næste periode, står beløbet automatisk som
        <b> Penge undervejs</b> på balancen{transit ? <> – lige nu <b>{kr(transit.close)}</b> ved periodens slutning (primo {kr(transit.open)})</> : ''}.
      </p>
      {!shown.length ? <Empty>{rows.length ? 'Alle interne overførsler er parret.' : 'Ingen interne overførsler i perioden.'}</Empty> : (
        <table>
          <thead><tr><th>Dato</th><th>Konto</th><th>Tekst</th><th className="num">Beløb</th><th>Modpost</th><th /></tr></thead>
          <tbody>
            {shown.map(({ t, target, pair, candidates }) => (
              <tr key={t.id}>
                <td className="small">{dateShort(t.date)}</td>
                <td className="small">{acc(t.accountId)?.name}</td>
                <td className="ellipsis" style={{ maxWidth: 280 }} title={t.text}>{t.text}</td>
                <td className="num"><Money v={t.amount} decimals colored /></td>
                <td className="small">
                  {target && target.kind !== 'bank' ? <span className="chip user">Direkte til {target.name}</span>
                    : pair ? (
                      <span>
                        <span className="chip user">⇄ {acc(pair.accountId)?.name} {dateShort(pair.date)}</span>
                        {!inPeriod(pair, period) && <span className="chip review" style={{ marginLeft: 4 }}>{pair.date > period.end ? 'lander i næste periode → undervejs' : 'kom fra forrige periode'}</span>}
                      </span>
                    ) : candidates.length ? (
                      candidates.map((c) => (
                        <div key={c.id} className="row" style={{ gap: 6 }}>
                          <span>Mulig: {acc(c.accountId)?.name} {dateShort(c.date)} "{c.text}"</span>
                          <button className="btn sm" onClick={() => {
                            setManual([c.id], { type: 'internal', targetAccountId: t.accountId });
                            setManual([t.id], { type: 'internal', targetAccountId: c.accountId });
                          }}>Par</button>
                        </div>
                      ))
                    ) : (
                      <span className="muted">Ingen modpost fundet. Står den på den rigtige post? Ellers bliver beløbet stående som "penge undervejs".</span>
                    )}
                </td>
                <td className="num">
                  <button className="btn sm" title="Åbn transaktionen i Kategorisér" onClick={() => useStore.getState().showTx(t.id)}>Vis overførsel →</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
