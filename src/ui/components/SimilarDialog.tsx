import { useEffect, useState } from 'react';
import { NEEDS_REVIEW, type Resolved } from '../../domain/classify';
import { dateShort } from '../../domain/format';
import { normalizeText } from '../../domain/normalize';
import type { Classification, Tx } from '../../domain/types';
import { saveRule, setManual, useEngine } from '../../store/actions';
import { useStore } from '../../store/store';
import { ClassEditor, Money, SourceChip, TxNotes, categoryLabel, isComplete } from './common';

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
  const all = [tx, ...similar].sort((a, b) => (a.date < b.date ? -1 : 1));
  const [cls, setCls] = useState<Classification>(initial);
  // Som standard: denne + dem der mangler en afgørelse. Allerede afgjorte vælges kun, hvis man selv vil.
  const [picked, setPicked] = useState<Set<string>>(() => new Set([tx.id, ...similar.filter((t) => NEEDS_REVIEW.has(e.resolved.get(t.id)!.source)).map((t) => t.id)]));
  const [remember, setRemember] = useState(false);
  const rulesOn = useStore((s) => s.data.settings.rulesEnabled === true);
  const allPicked = all.every((t) => picked.has(t.id));
  const pattern = normalizeText(tx.text);
  const acc = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? '';
  const describe = (r: Resolved) => {
    const l = r.lines[0];
    if (r.lines.length > 1) return `${r.lines.length} dele`;
    if (l.type === 'internal') return `Intern → ${data.accounts.find((a) => a.id === l.targetAccountId)?.name ?? '?'}`;
    return categoryLabel(data.categories, l.categoryId) || 'ingen kategori';
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const apply = () => {
    if (!isComplete(cls) || !picked.size) return;
    const ids = [...picked];
    if (rulesOn && remember && allPicked) saveRule(tx, cls, ids);
    else setManual(ids, cls);
    onApplied(ids.length);
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
          {all.length} transaktioner med samme tekst og retning. Vælg hvilke, og hvad de skal være.
        </p>

        <div className="section-label">Hvad skal de valgte være?</div>
        <div style={{ marginBottom: 14 }}>
          <ClassEditor value={cls} onChange={setCls} amount={tx.amount} accountId={tx.accountId} txId={tx.id} />
        </div>

        <div className="row small" style={{ marginBottom: 6 }}>
          <span className="section-label" style={{ margin: 0 }}>Transaktioner ({picked.size} valgt)</span>
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => setPicked(new Set(all.map((t) => t.id)))}>Vælg alle</button>
          <button className="btn sm ghost" onClick={() => setPicked(new Set())}>Fravælg alle</button>
        </div>
        <div className="modal-scroll">
          <table>
            <thead><tr><th /><th>Dato</th><th>Konto</th><th>Tekst</th><th className="num">Beløb</th><th>Nu</th></tr></thead>
            <tbody>
              {all.map((t) => {
                const r = e.resolved.get(t.id)!;
                return (
                  <tr key={t.id} className={`click ${picked.has(t.id) ? '' : 'muted-row'}`} onClick={() => toggle(t.id)}>
                    <td><input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} onClick={(ev) => ev.stopPropagation()} aria-label={`Vælg ${t.text} ${t.date}`} /></td>
                    <td className="small">{dateShort(t.date)}{t.id === tx.id && <div className="small muted">denne</div>}</td>
                    <td className="small muted">{acc(t.accountId)}</td>
                    <td style={{ maxWidth: 280 }}><div className="ellipsis" title={t.text}>{t.text}</div><TxNotes tx={t} /></td>
                    <td className="num"><Money v={t.amount} decimals colored /></td>
                    <td className="small"><SourceChip source={r.source} /> <span className="muted">{NEEDS_REVIEW.has(r.source) ? 'forslag: ' : ''}{describe(r)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="row" style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          {rulesOn && <label className={`row small ${allPicked ? 'ink2' : 'muted'}`} title={allPicked ? '' : 'En regel gælder alle med samme tekst – vælg dem alle for at gemme den'}>
            <input type="checkbox" checked={remember && allPicked} disabled={!allPicked} onChange={(ev) => setRemember(ev.target.checked)} />
            Husk som regel – også for fremtidige "{pattern}"
          </label>}
          <span className="spacer" />
          <button className="btn sm" onClick={onClose}>Annullér</button>
          <button className="btn sm primary" disabled={!isComplete(cls) || !picked.size} onClick={apply}>Anvend på {picked.size}</button>
        </div>
      </div>
    </div>
  );
}

export { clsOf as similarClsOf };
