import { useEffect, useRef, useState } from 'react';
import { dateShort, kr } from '../../domain/format';
import { isSettled, pairItems, settleState, unpair, withSettle, writeOffDifference, type SettleItem } from '../../domain/settle';
import { linkGroups, unlinkTx, type LinkGroup } from '../../domain/links';
import type { Account } from '../../domain/types';
import { useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { CategoryCombo, Money, InfoBox, SearchCombo, categoryLabel } from './common';

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
                <button className="btn sm primary" disabled={selItems.length < 2} title={selItems.length < 2 ? 'Vælg mindst to – eller føj den til en gruppe herunder' : undefined} onClick={() => pair([...sel])}>Par valgte</button>
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

/** Tilføj en post til afstemningen i en periode (eller fjern den igen) – valget gælder kun den periode. */
export const setPostSettle = (periodId: string, id: string, on: boolean) =>
  useStore.getState().update((d) => withSettle(d, periodId, id, on));

/**
 * Afstemning: det, du har valgt at afstemme i perioden –
 *  · poster, der følger dine overførsler (fx "Jonas skylder mig"): par bevægelserne og afskriv en difference
 *  · transaktioner, du har markeret som "hører sammen" i Kategorisér (fx et køb og en refusion)
 */
export function SettleOverview() {
  const e = useEngine();
  const period = usePeriod();
  const focus = useStore((s) => s.transferFocus);
  const [openId, setOpenId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tracked = e.data.accounts.filter((a) => a.kind === 'tracked');
  // Valget gælder kun denne periode – en post kan afstemmes i ét år og ikke i et andet.
  const posts = tracked.filter((a) => isSettled(period, a));
  const candidates = tracked.filter((a) => !isSettled(period, a) && !a.archived);
  const groups = linkGroups(e.data, period);
  // Kommer man fra en post eller "hører sammen": fold posten ud / rul hertil.
  useEffect(() => {
    if (!focus?.settle) return;
    if (focus.postId) setOpenId(focus.postId);
    useStore.getState().clearTransferFocus();
    setTimeout(() => ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  }, [focus]);
  return (
    <div className="card" ref={ref} id="afstemning">
      <div className="card-head">
        <h2 className="grow">Afstemning</h2>
        {candidates.length > 0 && (adding ? (
          <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
            <SearchCombo className="sm" options={candidates.map((a) => ({ id: a.id, label: a.name }))} value={undefined}
              onChange={(id) => { if (id && period) { setPostSettle(period.id, id, true); setOpenId(id); setAdding(false); } }}
              placeholder="Vælg post…" searchPlaceholder="Søg post…" ariaLabel="Tilføj post til afstemning" emptyText="Ingen post matcher" />
            <button className="btn sm ghost" onClick={() => setAdding(false)} aria-label="Annullér">✕</button>
          </span>
        ) : <button className="btn sm" onClick={() => { setAdding(true); setTimeout(() => document.querySelector<HTMLInputElement>('input[aria-label="Tilføj post til afstemning"]')?.focus(), 0); }}>+ Tilføj post</button>)}
      </div>
      <InfoBox label="Hvad kan afstemmes?">
        Her samles det, du har valgt at afstemme: <b>poster</b>, der følger dine overførsler (fx "Jonas skylder mig"), hvor du parrer et udlæg med tilbagebetalingen –
        og <b>parrede transaktioner</b>, som du har parret i Kategorisér (fx et udlæg og indbetalingen). Du ser med det samme, om det går op;
        gør det ikke, vælger du, hvor resten hører hjemme.
      </InfoBox>

      <div className="section-label">Poster</div>
      {!posts.length ? (
        <div className="small muted">Ingen poster valgt i {period?.name ?? 'perioden'}. Tryk "+ Tilføj post" og vælg fx "Jonas skylder mig" – valget gælder kun dette financial statement.</div>
      ) : (
        <table>
          <thead><tr><th>Post</th><th className="num">Saldo ultimo</th><th>Uparrede</th><th>Går ikke op</th><th /></tr></thead>
          <tbody>
            {posts.map((a) => {
              const st = settleState(e.data, e.ledger, a.id, period);
              const bad = st.groups.filter((g) => g.sum !== 0).length;
              const bal = st.items.reduce((s, i) => s + i.amount, 0);
              return [
                <tr key={a.id} className={`click ${openId === a.id ? 'expanded' : ''}`} onClick={(ev) => { if (!(ev.target as HTMLElement).closest('button')) setOpenId(openId === a.id ? undefined : a.id); }}>
                  <td><span className={`caret ${openId === a.id ? 'open' : ''}`} aria-hidden>›</span> {a.name}</td>
                  <td className="num"><Money v={bal} decimals /></td>
                  <td>{st.open.length ? <span className="chip review">{st.open.length}</span> : <span className="chip user">0</span>}</td>
                  <td>{bad ? <span className="chip review">{bad}</span> : <span className="muted small">–</span>}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm ghost" onClick={() => setOpenId(openId === a.id ? undefined : a.id)}>{openId === a.id ? 'Luk' : 'Afstem'}</button>
                    <button className="btn sm ghost" title="Se posten i Aktiver & passiver" onClick={() => useStore.getState().showPost(a.id)}>Post →</button>
                    <button className="btn sm ghost" title={`Fjern fra afstemningen i ${period?.name ?? 'perioden'} (dine parringer bevares)`} aria-label={`Fjern ${a.name} fra afstemningen`} onClick={() => { if (period) setPostSettle(period.id, a.id, false); if (openId === a.id) setOpenId(undefined); }}>✕</button>
                  </td>
                </tr>,
                openId === a.id && <tr key={`${a.id}-p`} className="drawer-row"><td colSpan={5}><div className="drawer"><SettlePanel acc={a} /></div></td></tr>,
              ];
            })}
          </tbody>
        </table>
      )}

      <div className="section-label" style={{ marginTop: 16 }}>Parrede transaktioner</div>
      {!groups.length
        ? <div className="small muted">Ingen endnu. Brug "⇄ Par…" ved en transaktion i Kategorisér – fx et udlæg og indbetalingen.</div>
        : <div className="col" style={{ gap: 6 }}>{groups.map((g) => <LinkGroupCard key={g.id} g={g} />)}</div>}
    </div>
  );
}

/** Parrede transaktioner (fx et udlæg og indbetalingen): summen, og hvilken kategori resten hører hjemme i. */
function LinkGroupCard({ g }: { g: LinkGroup }) {
  const e = useEngine();
  const update = useStore((s) => s.update);
  const showTx = useStore((s) => s.showTx);
  const acc = (id: string) => e.data.accounts.find((a) => a.id === id)?.name ?? '';
  // Resten hører hjemme i den kategori, de parrede står i – er de forskellige, vælger man én for dem alle.
  const cats = new Set(g.txs.map((t) => e.resolved.get(t.id)?.lines.find((l) => l.categoryId)?.categoryId ?? ''));
  const restCat = cats.size === 1 ? [...cats][0] || undefined : undefined;
  const placeRest = (categoryId: string) => update((d) => {
    const cat = d.categories.find((c) => c.id === categoryId);
    const ids = new Set(g.txs.map((t) => t.id));
    return { ...d, txs: d.txs.map((t) => (ids.has(t.id) ? { ...t, manual: { type: !cat || cat.kind === 'both' ? (t.amount > 0 ? 'income' : 'expense') : cat.kind, categoryId }, splits: undefined } : t)) };
  });
  const ok = g.sum === 0 || !!restCat;
  return (
    <div className={`xfer-item ${ok ? '' : 'missing'}`}>
      {g.txs.map((t) => (
        <div key={t.id} className="row small carried-line" style={{ borderTop: 0, marginTop: 0, paddingTop: 2 }}>
          <span className="muted" style={{ minWidth: 60 }}>{dateShort(t.date)}</span>
          <span className="muted" style={{ minWidth: 110 }}>{acc(t.accountId)}</span>
          <button className="linkish ellipsis" style={{ maxWidth: 380 }} title="Åbn i Kategorisér" onClick={() => showTx(t.id)}>{t.text}</button>
          <span className="spacer" />
          <Money v={t.amount} decimals colored />
          <button className="btn sm ghost" title="Ophæv parringen for denne (er der kun én tilbage, ophæves den også)" aria-label={`Ophæv ${t.text}`} onClick={() => update((d) => unlinkTx(d, t.id))}>✕</button>
        </div>
      ))}
      <div className="row small" style={{ gap: 8, marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--line)' }}>
        <span>I alt <b><Money v={g.sum} decimals signed /></b></span>
        {g.sum === 0 ? <span className="chip user">✓ Går op</span>
          : restCat ? <span className="chip user">Resten {kr(Math.abs(g.sum))} → {categoryLabel(e.data.categories, restCat)}</span>
          : <span className="chip review">Resten {kr(Math.abs(g.sum))} er ikke placeret</span>}
        <span className="spacer" />
        {g.sum !== 0 && (
          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <span className="ink2">{restCat ? 'Flyt resten til' : 'Hvor hører resten hjemme?'}</span>
            <CategoryCombo className="sm" value={restCat} onChange={(id) => id && placeRest(id)} primaryKind={g.sum < 0 ? 'expense' : 'income'} placeholder="vælg kategori" />
          </span>
        )}
      </div>
    </div>
  );
}

/** I postens detaljer: afstemningen, hvis posten er valgt – ellers en knap til at vælge den. */
export function SettleToggle({ acc }: { acc: Account }) {
  const period = usePeriod();
  const on = isSettled(period, acc);
  if (!period) return null;
  if (!on) return <div><button className="btn sm ghost" onClick={() => setPostSettle(period.id, acc.id, true)}>+ Afstem posten i {period.name} (par udlæg og tilbagebetalinger)</button></div>;
  return (
    <div className="col" style={{ gap: 4 }}>
      <SettlePanel acc={acc} />
      <div><button className="btn sm ghost" onClick={() => setPostSettle(period.id, acc.id, false)}>Stop afstemning af posten i {period.name}</button></div>
    </div>
  );
}
