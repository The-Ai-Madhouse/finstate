import { useEffect, useRef, useState } from 'react';
import type { Resolved } from '../../domain/classify';
import { kr } from '../../domain/format';
import type { Classification, Split, Tx } from '../../domain/types';
import { saveSplitRule, setManual, setSplits } from '../../store/actions';
import { useStore } from '../../store/store';
import { AmountInput, ClassEditor, Money, isComplete } from './common';

interface Part { cls: Classification; amt: number }
const clsOf = (l: Split): Classification => ({ type: l.type, categoryId: l.categoryId, counterparty: l.counterparty, targetAccountId: l.targetAccountId });

/**
 * Opdel én transaktion i flere dele – fx en udbetaling, der både er indtægt og en
 * intern overførsel til en anden post. Første linje er altid "resten" og regnes automatisk.
 */
export function SplitDialog({ tx, resolved, onClose, onSaved }: { tx: Tx; resolved: Resolved; onClose: () => void; onSaved?: () => void }) {
  const sign = tx.amount < 0 ? -1 : 1;
  const total = Math.abs(tx.amount);
  const initial = resolved.lines;
  const [rest, setRest] = useState<Classification>(() => clsOf(initial[0]));
  const [parts, setParts] = useState<Part[]>(() =>
    initial.length > 1 ? initial.slice(1).map((l) => ({ cls: clsOf(l), amt: Math.abs(l.amount) })) : [{ cls: { type: sign > 0 ? 'income' : 'expense' }, amt: 0 }],
  );
  const [remember, setRemember] = useState(false);
  const rulesOn = useStore((s) => s.data.settings.rulesEnabled === true);
  const categories = useStore((s) => s.data.categories);
  const [focusIdx, setFocusIdx] = useState(initial.length > 1 ? -1 : 0);
  const listRef = useRef<HTMLDivElement>(null);
  const restAmt = total - parts.reduce((s, p) => s + p.amt, 0);
  // Resten med fortegn: er delene større end beløbet, går resten den anden vej (fx en udgift, hvor resten bliver en indtægt).
  const restSigned = sign * restAmt;
  const restDir: 'income' | 'expense' = (restSigned === 0 ? tx.amount : restSigned) > 0 ? 'income' : 'expense';
  const flipped = restAmt < 0;
  const ok = parts.length > 0 && parts.every((p) => p.amt > 0 && isComplete(p.cls)) && (restAmt === 0 || isComplete(rest));

  // Skifter resten retning, skifter dens type med (indtægt ↔ udgift). En kategori, der går begge veje, bevares.
  // Det sidste valg for hver retning huskes, så man ikke mister det, hvis man skriver sig forbi og retter igen.
  const memo = useRef<Partial<Record<'income' | 'expense', Classification>>>({});
  useEffect(() => {
    setRest((r) => {
      if ((r.type !== 'income' && r.type !== 'expense') || r.type === restDir) return r;
      memo.current[r.type] = r;
      const cat = categories.find((c) => c.id === r.categoryId);
      return memo.current[restDir] ?? { type: restDir, categoryId: cat?.kind === 'both' ? cat.id : undefined };
    });
  }, [restDir, categories]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    if (!ok) return;
    if (rulesOn && remember) saveSplitRule(tx, rest, parts.map((p) => ({ cls: p.cls, amount: p.amt })));
    else if (restAmt === 0 && parts.length === 1) setManual([tx.id], parts[0].cls);
    else setSplits(tx.id, [...(restAmt ? [{ ...rest, amount: sign * restAmt }] : []), ...parts.map((p) => ({ ...p.cls, amount: sign * p.amt }))]);
    onSaved?.();
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal card split-modal" role="dialog" aria-label="Opdel transaktion" onMouseDown={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
        <div className="card-head">
          <h2 className="keep-case">Opdel "{tx.text}"</h2>
          <button className="btn sm ghost" onClick={onClose} aria-label="Luk">✕</button>
        </div>
        <p className="small ink2" style={{ marginBottom: 12 }}>
          {kr(total)} {sign < 0 ? 'ud' : 'ind'} fordelt på flere dele. Skriv beløbet for hver del – <b>resten</b> regnes automatisk.
        </p>

        <div className="split-list" ref={listRef}>
          <div className="split-line rest">
            <div className="split-amt">
              <span className="small muted">Resten{restAmt ? ` · ${restDir === 'income' ? 'ind' : 'ud'}` : ''}</span>
              <b><Money precise v={Math.abs(restAmt)} /></b>
            </div>
            <ClassEditor key={restDir} value={rest} onChange={setRest} amount={restSigned || sign} accountId={tx.accountId} compact />
            <span />
          </div>
          {parts.map((p, i) => (
            <div key={i} className="split-line">
              <div className="split-amt">
                <AmountInput className="sm" value={p.amt || undefined} placeholder="beløb" ariaLabel={`Beløb for del ${i + 1}`} autoFocus={i === focusIdx}
                  onLive={(v) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, amt: Math.abs(v ?? 0) } : x)))}
                  onCommit={(v) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, amt: Math.abs(v ?? 0) } : x)))} />
              </div>
              <ClassEditor value={p.cls} amount={sign * Math.max(p.amt, 1)} accountId={tx.accountId} compact
                onChange={(c) => setParts(parts.map((x, j) => (j === i ? { ...x, cls: c } : x)))} />
              <button className="btn sm ghost" onClick={() => setParts(parts.filter((_, j) => j !== i))} aria-label="Fjern del">✕</button>
            </div>
          ))}
        </div>
        <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => { setParts([...parts, { cls: { type: sign > 0 ? 'income' : 'expense' }, amt: 0 }]); setFocusIdx(parts.length); }}>+ Tilføj del</button>

        <div className="row" style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          {rulesOn && <label className="row small ink2" title="De faste beløb huskes for samme tekst; resten følger beløbet. Godt til fx en løn, hvor en fast del går til pension.">
            <input type="checkbox" checked={remember} onChange={(ev) => setRemember(ev.target.checked)} /> Husk opdelingen fremover
          </label>}
          <span className="small ink2">{flipped ? `Delene er ${kr(-restAmt)} større end beløbet – resten bliver ${restDir === 'income' ? 'en indtægt' : 'en udgift'}.` : ''}</span>
          <span className="spacer" />
          {(tx.splits?.length ?? 0) > 0 && <button className="btn sm ghost" onClick={() => { setSplits(tx.id, undefined); onClose(); }}>Fjern opdeling</button>}
          <button className="btn sm" onClick={onClose}>Annullér</button>
          <button className="btn sm primary" disabled={!ok} onClick={save}>Gem opdeling</button>
        </div>
      </div>
    </div>
  );
}
