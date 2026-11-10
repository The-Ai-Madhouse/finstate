import { useState } from 'react';
import { dateShort, kr } from '../../domain/format';
import { pairItems, settleState, unpair, writeOffDifference, type SettleItem } from '../../domain/settle';
import type { Account } from '../../domain/types';
import { useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { CategoryCombo, Money, InfoBox } from './common';

/**
 * Afstemning af en post, der følger overførsler (udlæg, tilgodehavender, gæld til personer):
 * par det, der hører sammen – fx et udlæg og tilbagebetalingen – og se med det samme, om det går op.
 */
export function SettlePanel({ acc }: { acc: Account }) {
  const e = useEngine();
  const update = useStore((s) => s.update);
  const showTx = useStore((s) => s.showTx);
  // Kun det valgte financial statement: periodens bevægelser + saldoen fra før perioden som én linje.
  const period = usePeriod();
  const st = settleState(e.data, e.ledger, acc.id, period);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const selItems = st.open.filter((i) => sel.has(i.key));
  const selSum = selItems.reduce((s, i) => s + i.amount, 0);
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pair = (keys: string[], into?: string) => { update((d) => pairItems(d, acc.id, keys, into)); setSel(new Set()); };
  const done = st.groups.filter((g) => g.sum === 0);
  const notDone = st.groups.filter((g) => g.sum !== 0);
  const shownGroups = showDone ? st.groups : notDone;

  if (!st.items.length) return <div className="small muted">Ingen bevægelser på posten{period ? ` i ${period.name}` : ''}. Vælg "Intern" og posten, når du kategoriserer et udlæg eller en tilbagebetaling.</div>;

  const itemRow = (i: SettleItem, extra?: React.ReactNode) => (
    <tr key={i.key} className={i.primo ? 'settle-primo' : undefined}>
      <td style={{ width: 28 }}>{extra}</td>
      <td className="small" style={{ whiteSpace: 'nowrap' }}>{i.primo ? 'primo' : dateShort(i.date)}</td>
      <td className="ellipsis" style={{ maxWidth: 360 }} title={i.primo ? `Saldoen pr. ${dateShort(i.date)} – alt fra før perioden samlet` : i.text}>{i.text}</td>
      <td className="num"><Money v={i.amount} decimals signed colored /></td>
      <td className="num">{i.txId && <button className="btn sm ghost" title="Vis transaktionen i Kategorisér" onClick={() => showTx(i.txId!)}>Vis →</button>}</td>
    </tr>
  );

  return (
    <div className="settle">
      <div className="row small" style={{ marginBottom: 6 }}>
        <b>Afstemning</b>
        <InfoBox label="Fortegn og periode">+ øger saldoen (fx et udlæg), − mindsker den (fx en tilbagebetaling). En gruppe går op, når summen er 0.
          Kun {period ? period.name : 'periodens'} bevægelser vises; alt fra før perioden står samlet som "Saldo primo" og kan parres med periodens bevægelser.</InfoBox>
        <span className="spacer" />
        <span className={`chip ${st.open.length ? 'review' : 'user'}`}>{st.open.length} uparrede</span>
        <span className="chip">{done.length} udlignet</span>
      </div>

      {st.suggestions.length > 0 && (
        <div className="settle-suggest">
          <div className="row small">
            <span className="ink2">Forslag – samme beløb ud og ind:</span>
            <span className="spacer" />
            {st.suggestions.length > 1 && <button className="btn sm" onClick={() => update((d) => st.suggestions.reduce((x, [a, b]) => pairItems(x, acc.id, [a.key, b.key]), d))}>Par alle {st.suggestions.length}</button>}
          </div>
          {st.suggestions.slice(0, 5).map(([a, b]) => (
            <div key={a.key + b.key} className="row small" style={{ gap: 6 }}>
              <span>{a.primo ? 'Saldo primo' : `${dateShort(a.date)} "${a.text}"`} <Money v={a.amount} decimals signed /></span>
              <span className="muted">↔</span>
              <span>{b.primo ? 'Saldo primo' : `${dateShort(b.date)} "${b.text}"`} <Money v={b.amount} decimals signed /></span>
              <button className="btn sm" onClick={() => pair([a.key, b.key])}>Par</button>
            </div>
          ))}
        </div>
      )}

      {st.open.length > 0 && (
        <>
          <div className="section-label">Uparrede bevægelser</div>
          <table className="small">
            <tbody>{st.open.map((i) => itemRow(i, <input type="checkbox" checked={sel.has(i.key)} onChange={() => toggle(i.key)} aria-label={`Vælg ${i.text}`} />))}</tbody>
          </table>
          <div className="row small" style={{ marginTop: 4 }}>
            {selItems.length > 0 ? (
              <>
                <span>Valgt: {selItems.length} · sum <Money v={selSum} decimals signed /></span>
                {selSum === 0 ? <span className="chip user">går op</span> : <span className="chip review">difference {kr(Math.abs(selSum))}</span>}
                <button className="btn sm primary" onClick={() => pair([...sel])}>Par valgte</button>
                {notDone.length > 0 && <span className="muted">eller føj til en gruppe herunder</span>}
              </>
            ) : <span className="muted">Sæt flueben ved det, der hører sammen.</span>}
          </div>
        </>
      )}

      {(shownGroups.length > 0 || done.length > 0) && (
        <div className="row small" style={{ marginTop: 10 }}>
          <div className="section-label grow" style={{ margin: 0 }}>Grupper</div>
          {done.length > 0 && <label className="row small ink2"><input type="checkbox" checked={showDone} onChange={(ev) => setShowDone(ev.target.checked)} /> Vis udlignede ({done.length})</label>}
        </div>
      )}
      {shownGroups.map((g) => (
        <div key={g.match.id} className={`settle-group ${g.sum === 0 ? 'ok' : 'diff'}`}>
          <table className="small">
            <tbody>{g.items.map((i) => itemRow(i, <button className="btn sm ghost" title="Tag ud af gruppen" aria-label="Tag ud af gruppen" onClick={() => update((d) => unpair(d, g.match.id, i.key))}>✕</button>))}</tbody>
          </table>
          <div className="row small" style={{ marginTop: 4 }}>
            {g.sum === 0 ? <span className="chip user">✓ Udlignet</span> : (
              <>
                <span className="chip review">{g.sum > 0 ? `Mangler ${kr(g.sum)}` : `${kr(-g.sum)} for meget`}</span>
                <WriteOff onPick={(categoryId) => update((d) => writeOffDifference(d, e.ledger, g.match.id, categoryId, period))} sum={g.sum} />
              </>
            )}
            <span className="spacer" />
            {selItems.length > 0 && <button className="btn sm" onClick={() => pair([...sel], g.match.id)}>Føj valgte hertil</button>}
            <button className="btn sm ghost" onClick={() => update((d) => unpair(d, g.match.id))}>Opløs</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Afskriv en difference som udgift/indtægt (fx "lad de 50 kr gå"). */
function WriteOff({ onPick, sum }: { onPick: (categoryId: string) => void; sum: number }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="btn sm ghost" title="Bogfør differencen som en udgift eller indtægt, så gruppen går op" onClick={() => setOpen(true)}>Afskriv differencen…</button>;
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
      <span className="ink2">som</span>
      <CategoryCombo className="sm" primaryKind={sum > 0 ? 'expense' : 'income'} onChange={(id) => { if (id) { onPick(id); setOpen(false); } }} placeholder="vælg kategori" />
      <button className="btn sm ghost" onClick={() => setOpen(false)} aria-label="Annullér">✕</button>
    </span>
  );
}
