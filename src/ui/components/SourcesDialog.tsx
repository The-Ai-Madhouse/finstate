import { useEffect } from 'react';
import { addDays } from '../../domain/util';
import { dateShort, kr } from '../../domain/format';
import { balanceSources, plSources } from '../../domain/ledger';
import type { Period } from '../../domain/types';
import { useEngine } from '../../store/actions';
import { useStore } from '../../store/store';
import { Money, categoryLabel } from './common';

/**
 * "Hvor kommer beløbet fra?" – transaktioner, værdiændringer på aktiver/passiver og manuelle poster,
 * der tilsammen giver tallet i regnskabet.
 */
export function SourcesDialog({ title, refs, kind, period, onClose }: {
  title: string;
  refs: Set<string>;
  kind: 'income' | 'expense';
  period: Period;
  onClose: () => void;
}) {
  const e = useEngine();
  const { data } = e;
  const { showTx, setView } = useStore.getState();
  const src = plSources(data, e.ledger, period, refs);
  // Vis beløb som i regnskabet: indtægter positive, udgifter positive (refusion negativ).
  const show = (v: number) => (kind === 'income' ? v : -v);
  const acc = (id?: string) => data.accounts.find((a) => a.id === id);
  const catName = (ref: string) => (ref.startsWith('cat:') ? categoryLabel(data.categories, ref.slice(4)) : kind === 'income' ? 'Ukategoriseret' : 'Ukategoriseret');
  const multiCat = new Set([...src.tx, ...src.other].map((p) => p.ref)).size > 1;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal card" role="dialog" aria-label={title} onMouseDown={(ev) => ev.stopPropagation()}>
        <div className="card-head">
          <h2 className="keep-case">Hvor kommer {title} fra?</h2>
          <button className="btn sm ghost" onClick={onClose} aria-label="Luk">✕</button>
        </div>
        <p className="small ink2" style={{ marginBottom: 12 }}>{period.name} · {dateShort(period.start)} – {dateShort(period.end)}</p>

        {src.valuations.length > 0 && (
          <section className="modal-section">
            <div className="section-label">Værdiændring på aktiver/passiver</div>
            <p className="small muted" style={{ marginBottom: 6 }}>
              Ikke en transaktion: det er det, posten har ændret sig <i>ud over</i> dine egne indskud/afdrag.
            </p>
            <table>
              <thead><tr><th>Post</th><th>Fra → til</th><th className="num">Værdi</th><th className="num">Dine overførsler</th><th className="num">= Beløb</th><th /></tr></thead>
              <tbody>
                {src.valuations.map((v) => {
                  const a = acc(v.accountId);
                  const sign = a?.side === 'liability' ? -1 : 1;
                  return (
                    <tr key={v.valuationId}>
                      <td>{a?.name}</td>
                      <td className="small">{v.from ? `${dateShort(v.from)} → ${dateShort(v.to)}` : dateShort(v.to)}</td>
                      <td className="num small">{kr(sign * v.valueFrom)} → {kr(sign * v.valueTo)}<div className="muted">{(v.valueTo - v.valueFrom) * sign >= 0 ? '+' : '−'}{kr(Math.abs(v.valueTo - v.valueFrom))}</div></td>
                      <td className="num small">{v.transfers ? `${v.transfers * sign > 0 ? '−' : '+'}${kr(Math.abs(v.transfers))}` : '0 kr'}</td>
                      <td className="num"><b><Money v={show(v.amount)} /></b></td>
                      <td className="num"><button className="btn sm ghost" onClick={() => { onClose(); setView('balance'); }}>Se i balancen →</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {src.tx.length > 0 && (
          <section className="modal-section">
            <div className="section-label">Transaktioner ({src.tx.length})</div>
            <div className="modal-scroll">
              <table>
                <thead><tr><th>Dato</th><th>Konto</th><th>Tekst</th>{multiCat && <th>Kategori</th>}<th className="num">Beløb</th><th /></tr></thead>
                <tbody>
                  {[...src.tx].sort((a, b) => (a.date < b.date ? -1 : 1)).map((p, i) => {
                    const t = e.txById.get(p.txId!)!;
                    const partial = t && Math.abs(t.amount) !== Math.abs(p.amount);
                    return (
                      <tr key={p.txId! + i}>
                        <td className="small">{dateShort(p.date)}</td>
                        <td className="small muted">{acc(t?.accountId)?.name}</td>
                        <td className="ellipsis" style={{ maxWidth: 320 }} title={t?.text}>{t?.text}{partial && <span className="small muted"> (del af {kr(t.amount)})</span>}</td>
                        {multiCat && <td className="small muted">{catName(p.ref)}</td>}
                        <td className="num"><Money v={show(p.amount)} decimals /></td>
                        <td className="num"><button className="btn sm ghost" onClick={() => { onClose(); showTx(p.txId!); }}>Vis →</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {src.other.length > 0 && (
          <section className="modal-section">
            <div className="section-label">Manuelle poster</div>
            <table>
              <tbody>
                {src.other.map((p, i) => {
                  const o = data.openItems.find((x) => x.id === p.openItemId);
                  return (
                    <tr key={i}>
                      <td className="small">{dateShort(p.date)}</td>
                      <td>{o ? `${o.note ?? 'Afskrivning'} – ${acc(o.accountId)?.name ?? o.counterparty}` : 'Manuel post'}</td>
                      <td className="num"><Money v={show(p.amount)} decimals /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {!src.tx.length && !src.valuations.length && !src.other.length && <p className="muted">Ingen bevægelser i perioden.</p>}

        <div className="row" style={{ marginTop: 12, borderTop: '1.5px solid var(--ink)', paddingTop: 10 }}>
          <b>I alt</b>
          <span className="spacer" />
          <b><Money v={show(src.total)} decimals /></b>
        </div>
      </div>
    </div>
  );
}

/**
 * "Hvad består posten af?" – primo, alle bevægelser i perioden og ultimo for en balancepost.
 */
export function BalanceSourcesDialog({ refKey, label, side, period, onClose }: {
  refKey: string;
  label: string;
  side: 'asset' | 'liability';
  period: Period;
  onClose: () => void;
}) {
  const e = useEngine();
  const { data } = e;
  const { showTx } = useStore.getState();
  const src = balanceSources(e.ledger, refKey, period);
  const sign = side === 'asset' ? 1 : -1;
  const ownAccountId = refKey.startsWith('acc:') ? refKey.slice(4) : undefined;
  const acc = (id?: string) => data.accounts.find((a) => a.id === id);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const describe = (p: (typeof src.moves)[number]) => {
    if (p.txId) {
      const t = e.txById.get(p.txId);
      const from = t && t.accountId !== ownAccountId ? acc(t.accountId)?.name : undefined;
      return { text: t?.text ?? 'Transaktion', where: from ? `${p.amount * sign > 0 ? 'fra' : 'til'} ${from}` : '', txId: p.txId, note: t?.memo };
    }
    if (p.openItemId) {
      const o = data.openItems.find((x) => x.id === p.openItemId);
      return { text: o?.categoryId ? `Afskrivning (${categoryLabel(data.categories, o.categoryId)})` : 'Startsaldo', where: o?.note ?? '' };
    }
    if (p.valuationId) return { text: 'Værdiændring ud over dine overførsler (afkast/renter)', where: '' };
    return { text: 'Åbningssaldo', where: '' };
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal card" role="dialog" aria-label={label} onMouseDown={(ev) => ev.stopPropagation()}>
        <div className="card-head">
          <h2 className="keep-case">Hvad består {label} af?</h2>
          <button className="btn sm ghost" onClick={onClose} aria-label="Luk">✕</button>
        </div>
        <p className="small ink2" style={{ marginBottom: 12 }}>{period.name} · {dateShort(period.start)} – {dateShort(period.end)}</p>

        <div className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--line-strong)' }}>
          <b>Primo</b><span className="muted small">pr. {dateShort(addDays(period.start, -1))}</span><span className="spacer" /><b><Money precise v={sign * src.primo} /></b>
        </div>

        <section className="modal-section" style={{ marginTop: 10 }}>
          <div className="section-label">Bevægelser i perioden ({src.moves.length})</div>
          {!src.moves.length ? <p className="muted small">Ingen bevægelser i perioden.</p> : (
            <div className="modal-scroll">
              <table>
                <thead><tr><th>Dato</th><th>Tekst</th><th>Fra/til</th><th className="num">Beløb</th><th /></tr></thead>
                <tbody>
                  {[...src.moves].sort((a, b) => (a.date < b.date ? -1 : 1)).map((p, i) => {
                    const d = describe(p);
                    return (
                      <tr key={i}>
                        <td className="small">{dateShort(p.date)}</td>
                        <td className="ellipsis" style={{ maxWidth: 340 }} title={d.text}>{d.text}{d.note && <div className="small muted ellipsis">✎ {d.note}</div>}</td>
                        <td className="small muted">{d.where}</td>
                        <td className="num"><Money precise signed colored v={sign * p.amount} /></td>
                        <td className="num">{d.txId && <button className="btn sm ghost" onClick={() => { onClose(); showTx(d.txId!); }}>Vis →</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="row" style={{ marginTop: 12, borderTop: '1.5px solid var(--ink)', paddingTop: 10 }}>
          <b>Ultimo</b><span className="muted small">pr. {dateShort(period.end)} = primo {sign * (src.ultimo - src.primo) >= 0 ? '+' : '−'} {kr(Math.abs(src.ultimo - src.primo))}</span>
          <span className="spacer" />
          <b><Money precise v={sign * src.ultimo} /></b>
        </div>
      </div>
    </div>
  );
}
