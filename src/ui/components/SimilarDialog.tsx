import { useEffect, useState } from 'react';
import { NEEDS_REVIEW, splitLines, type Resolved } from '../../domain/classify';
import { inPeriod } from '../../domain/engine';
import { dateShort, kr } from '../../domain/format';
import { normalizeText } from '../../domain/normalize';
import type { Classification, Tx } from '../../domain/types';
import { applySplitTo, saveRule, saveSplitRule, setManual, useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { AmountInput, ClassEditor, Money, SourceChip, TxNotes, categoryLabel, isComplete } from './common';

const clsOf = (r: Resolved): Classification => {
  const { type, categoryId, counterparty, targetAccountId } = r.lines[0];
  return { type, categoryId, counterparty, targetAccountId };
};

/**
 * "Lignende transaktioner": se alle med samme tekst, vælg til/fra, vælg hvad de skal være –
 * og gem det evt. som regel. Intet sker, før man trykker "Anvend".
 */
export function SimilarDialog({ tx, similar, initial, onClose, onApplied }: {
  tx: Tx;
  similar: Tx[];
  initial: Classification;
  onClose: () => void;
  onApplied: (count: number) => void;
}) {
  const e = useEngine();
  const { data } = e;
  const period = usePeriod();
  const r0 = e.resolved.get(tx.id)!;
  const everything = [tx, ...similar].sort((a, b) => (a.date < b.date ? -1 : 1));
  // Kun det aktuelle financial statement som standard – andre perioder kan vises til.
  const [showOther, setShowOther] = useState(false);
  const isOther = (t: Tx) => !!period && !inPeriod(t, period) && t.id !== tx.id;
  const otherCount = everything.filter(isOther).length;
  const all = showOther ? everything : everything.filter((t) => !isOther(t));
  const visible = new Set(all.map((t) => t.id));
  const [cls, setCls] = useState<Classification>(initial);
  // Én kategori eller opdeling – en allerede opdelt transaktion starter i "Opdel" med sin opdeling.
  const [mode, setMode] = useState<'one' | 'split'>(r0.lines.length > 1 ? 'split' : 'one');
  const sign = tx.amount < 0 ? -1 : 1;
  const [rest, setRest] = useState<Classification>(() => (r0.lines.length > 1 ? clsOf({ ...r0, lines: [r0.lines[0]] }) : initial));
  const [parts, setParts] = useState<{ cls: Classification; amt: number }[]>(() =>
    r0.lines.length > 1 ? r0.lines.slice(1).map((l) => ({ cls: clsOf({ ...r0, lines: [l] }), amt: Math.abs(l.amount) })) : [{ cls: { type: sign > 0 ? 'income' : 'expense' }, amt: 0 }],
  );
  const splitSpec = [{ cls: rest }, ...parts.map((p) => ({ cls: p.cls, amount: p.amt }))];
  const splitOk = parts.length > 0 && parts.every((p) => p.amt > 0 && isComplete(p.cls)) && isComplete(rest);
  // Som standard: denne + dem der mangler en afgørelse. Allerede afgjorte vælges kun, hvis man selv vil.
  const [picked, setPicked] = useState<Set<string>>(() => new Set([tx.id, ...similar.filter((t) => NEEDS_REVIEW.has(e.resolved.get(t.id)!.source)).map((t) => t.id)]));
  const chosen = [...picked].filter((id) => visible.has(id));
  const [remember, setRemember] = useState(false);
  const rulesOn = useStore((s) => s.data.settings.rulesEnabled === true);
  const allPicked = everything.every((t) => picked.has(t.id) && visible.has(t.id));
  const pattern = normalizeText(tx.text);
  const acc = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? '';
  const lineLabel = (l: { type: string; categoryId?: string; targetAccountId?: string }) =>
    l.type === 'internal' ? `Intern → ${data.accounts.find((a) => a.id === l.targetAccountId)?.name ?? '?'}` : categoryLabel(data.categories, l.categoryId) || 'ingen kategori';
  const describe = (r: Resolved) => (r.lines.length > 1 ? r.lines.map((l) => `${lineLabel(l)} ${kr(Math.abs(l.amount))}`).join(' + ') : lineLabel(r.lines[0]));

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ready = chosen.length > 0 && (mode === 'one' ? isComplete(cls) : splitOk);
  const apply = () => {
    if (!ready) return;
    if (mode === 'one') {
      if (rulesOn && remember && allPicked) saveRule(tx, cls, chosen);
      else setManual(chosen, cls);
    } else {
      applySplitTo(chosen, splitSpec);
      if (rulesOn && remember && allPicked) saveSplitRule(tx, rest, parts.map((p) => ({ cls: p.cls, amount: p.amt })));
    }
    onApplied(chosen.length);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal card" role="dialog" aria-label="Lignende transaktioner" onMouseDown={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => ev.stopPropagation()}>
        <div className="card-head">
          <h2 className="keep-case">Lignende: "{tx.text}"</h2>
          <button className="btn sm ghost" onClick={onClose} aria-label="Luk">✕</button>
        </div>
        <p className="small ink2" style={{ marginBottom: 10 }}>
          {all.length} transaktioner med samme tekst og retning{otherCount && !showOther ? ` i ${period?.name}` : ''}. Vælg hvilke, og hvad de skal være – én kategori eller en opdeling.
        </p>

        <div className="row" style={{ marginBottom: 6 }}>
          <span className="section-label" style={{ margin: 0 }}>Hvad skal de valgte være?</span>
          <div className="seg" role="radiogroup" aria-label="Én kategori eller opdeling">
            <button className={mode === 'one' ? 'on plain' : ''} role="radio" aria-checked={mode === 'one'} onClick={() => setMode('one')}>Én kategori</button>
            <button className={mode === 'split' ? 'on plain' : ''} role="radio" aria-checked={mode === 'split'} onClick={() => setMode('split')}>Opdel</button>
          </div>
        </div>
        {mode === 'one' ? (
          <div style={{ marginBottom: 14 }}>
            <ClassEditor value={cls} onChange={setCls} amount={tx.amount} accountId={tx.accountId} txId={tx.id} />
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            <p className="small ink2" style={{ marginBottom: 6 }}>
              Faste beløb trækkes ud af <b>hver</b> valgt transaktion; <b>resten</b> af hvert beløb går til den første linje. Er en transaktion mindre end de faste beløb, går det hele til resten.
            </p>
            <div className="split-list">
              <div className="split-line rest">
                <div className="split-amt"><span className="small muted">Resten</span></div>
                <ClassEditor value={rest} onChange={setRest} amount={tx.amount} accountId={tx.accountId} compact />
                <span />
              </div>
              {parts.map((p, i) => (
                <div key={i} className="split-line">
                  <div className="split-amt">
                    <AmountInput className="sm" value={p.amt || undefined} placeholder="beløb" ariaLabel={`Fast beløb for del ${i + 1}`}
                      onCommit={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, amt: Math.abs(v ?? 0) } : x)))} />
                  </div>
                  <ClassEditor value={p.cls} amount={sign * Math.max(p.amt, 1)} accountId={tx.accountId} compact
                    onChange={(c) => setParts(parts.map((x, j) => (j === i ? { ...x, cls: c } : x)))} />
                  <button className="btn sm ghost" onClick={() => setParts(parts.filter((_, j) => j !== i))} aria-label="Fjern del">✕</button>
                </div>
              ))}
            </div>
            <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setParts([...parts, { cls: { type: sign > 0 ? 'income' : 'expense' }, amt: 0 }])}>+ Tilføj del</button>
          </div>
        )}

        <div className="row small" style={{ marginBottom: 6 }}>
          <span className="section-label" style={{ margin: 0 }}>Transaktioner ({chosen.length} valgt)</span>
          {otherCount > 0 && (
            <label className="row small ink2" style={{ marginLeft: 10 }} title="Transaktioner med samme tekst i andre financial statements">
              <input type="checkbox" checked={showOther} onChange={(ev) => setShowOther(ev.target.checked)} /> Vis også {otherCount} fra andre perioder
            </label>
          )}
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => setPicked(new Set(all.map((t) => t.id)))}>Vælg alle</button>
          <button className="btn sm ghost" onClick={() => setPicked(new Set())}>Fravælg alle</button>
        </div>
        <div className="modal-scroll">
          <table>
            <thead><tr><th /><th>Dato</th><th>Konto</th><th>Tekst</th><th className="num">Beløb</th><th>Nu</th>{mode === 'split' && <th>Bliver til</th>}</tr></thead>
            <tbody>
              {all.map((t) => {
                const r = e.resolved.get(t.id)!;
                return (
                  <tr key={t.id} className={`click ${picked.has(t.id) ? '' : 'muted-row'}`} onClick={() => toggle(t.id)}>
                    <td><input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} onClick={(ev) => ev.stopPropagation()} aria-label={`Vælg ${t.text} ${t.date}`} /></td>
                    <td className="small">{dateShort(t.date)}{t.id === tx.id && <div className="small muted">denne</div>}{isOther(t) && <div className="small muted">anden periode</div>}</td>
                    <td className="small muted">{acc(t.accountId)}</td>
                    <td style={{ maxWidth: 280 }}><div className="ellipsis" title={t.text}>{t.text}</div><TxNotes tx={t} /></td>
                    <td className="num"><Money v={t.amount} decimals colored /></td>
                    <td className="small"><SourceChip source={r.source} /> <span className="muted">{NEEDS_REVIEW.has(r.source) ? 'forslag: ' : ''}{describe(r)}</span></td>
                    {mode === 'split' && <td className="small">{picked.has(t.id) && splitOk ? splitLines(t, splitSpec).map((l) => `${lineLabel(l)} ${kr(Math.abs(l.amount))}`).join(' + ') : ''}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="row" style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          {rulesOn && <label className={`row small ${allPicked ? 'ink2' : 'muted'}`} title={allPicked ? '' : 'En regel gælder alle med samme tekst – vælg dem alle for at gemme den'}>
            <input type="checkbox" checked={remember && allPicked} disabled={!allPicked} onChange={(ev) => setRemember(ev.target.checked)} />
            {mode === 'split' ? 'Husk opdelingen som regel' : 'Husk som regel'} – også for fremtidige "{pattern}"
          </label>}
          <span className="spacer" />
          <button className="btn sm" onClick={onClose}>Annullér</button>
          <button className="btn sm primary" disabled={!ready} onClick={apply}>{mode === 'split' ? 'Opdel' : 'Anvend på'} {chosen.length}</button>
        </div>
      </div>
    </div>
  );
}

export { clsOf as similarClsOf };
