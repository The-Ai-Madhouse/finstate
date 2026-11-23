import { useEffect, useRef, useState } from 'react';
import { dateShort, kr2f } from '../../domain/format';
import type { Classification, Tx } from '../../domain/types';
import { linkAll, pairBank, pairOnPost, pairPlain, setManual, useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { CategoryCombo, ClassEditor, DiffPill, Money, SearchCombo, isComplete, validPick } from './common';

/**
 * Par to transaktioner – med samme valg som i kategoriseringen (udgift/indtægt eller intern), der gælder for begge.
 *  · Udgift/indtægt: begge i kategorien, så kun forskellen tæller.
 *  · Intern: på en post (fx "Jonas skylder mig") afstemmes de dér; en forskel kan afskrives – ellers bliver den stående
 *    (og kan senere afskrives eller tages med til næste periode under Afstemning).
 */
export function PairDialog() {
  const draft = useStore((s) => s.pairDraft);
  const close = () => useStore.getState().setPairDraft(undefined);
  useEffect(() => {
    if (!draft) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);
  if (!draft) return null;
  // Nøglen er kun kilden: tilføjer eller fjerner man transaktioner i vinduet, bevares det valgte (fx Intern).
  return <PairDialogInner key={draft.pick.txId} />;
}

function PairDialogInner() {
  const e = useEngine();
  const period = usePeriod();
  const draft = useStore((s) => s.pairDraft)!;
  const close = () => useStore.getState().setPairDraft(undefined);
  const { pick, otherIds } = draft;
  const a = e.txById.get(pick.txId);
  const others = otherIds.map((id) => e.txById.get(id)).filter((t): t is Tx => !!t);
  const b = others[0];
  const all = a ? [a, ...others] : others;
  const sum = all.reduce((s, t) => s + t.amount, 0); // fra bankens side
  // Samme valg som i kategoriseringen – forudfyldt med det, en af dem allerede er.
  const [cls, setCls] = useState<Classification>(() => {
    if (pick.cls) return pick.cls;
    if (pick.mode === 'bank' && a && b) return { type: 'internal', targetAccountId: b.accountId };
    if (pick.postId) return { type: 'internal', targetAccountId: pick.postId };
    for (const t of all) {
      const l = t && e.resolved.get(t.id)?.lines.find((x) => (x.type === 'internal' && x.targetAccountId) || x.categoryId);
      if (l?.type === 'internal' && l.targetAccountId !== a?.accountId) return { type: 'internal', targetAccountId: l.targetAccountId };
      if (l?.categoryId) return { type: l.type, categoryId: l.categoryId };
    }
    return { type: sum < 0 ? 'expense' : 'income' };
  });
  const [writeOff, setWriteOff] = useState(false);
  const [writeOffCat, setWriteOffCat] = useState<string>();
  // Enter bekræfter parringen (men ikke mens man skriver i et felt eller vælger i en liste).
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (ev.key === 'Enter' && !typing && !ev.defaultPrevented) { ev.preventDefault(); saveRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!a || !b || !period) return null;
  const acc = (id?: string) => e.data.accounts.find((x) => x.id === id);
  const zero = sum === 0;
  const internal = cls.type === 'internal';
  const target = acc(cls.targetAccountId);
  // Afskrivning giver kun mening ved intern: ved udgift/indtægt er forskellen allerede den udgift/indtægt.
  const canWriteOff = internal && !zero;
  const ok = isComplete(cls) && (!canWriteOff || !writeOff || !!writeOffCat);
  const save = () => {
    if (!ok) return;
    const wo = canWriteOff && writeOff ? writeOffCat : undefined;
    const ids = all.map((t) => t.id);
    if (!internal) pairPlain(ids, cls.categoryId!);
    else if (target?.kind === 'tracked') pairOnPost(period, target.id, ids, wo);
    else if (others.length === 1 && target && (target.id === a.accountId || target.id === b.accountId || target.kind === 'bank')) pairBank(a.id, b.id, wo);
    else { setManual(ids, cls); useStore.getState().update((d) => linkAll(d, ids)); }
    close();
  };
  saveRef.current = save;
  // Vælg videre: tilføj eller fjern transaktioner, inden der parres. En overførsel mellem dine konti har kun én modpost.
  const setOthers = (ids: string[]) => useStore.getState().setPairDraft({ pick, otherIds: ids });
  const canAdd = pick.mode !== 'bank';
  const addOptions = canAdd ? e.data.txs
    .filter((t) => t.date >= period.start && t.date <= period.end && !otherIds.includes(t.id) && validPick(pick, t, e.data.txs))
    .sort((x, y) => Math.abs(x.amount + sum) - Math.abs(y.amount + sum) || Math.abs(Date.parse(x.date) - Date.parse(a.date)) - Math.abs(Date.parse(y.date) - Date.parse(a.date)))
    .slice(0, 400)
    .map((t) => ({ id: t.id, label: `${dateShort(t.date)} · ${t.text} · ${kr2f(t.amount)}`, hint: `· ${acc(t.accountId)?.name ?? ''}${t.amount + sum === 0 ? ' · går op' : ''}` })) : [];
  const backToList = () => { close(); useStore.getState().setLinkPick({ ...pick, others: otherIds, cls }); };
  const line = (t: Tx) => (
    <div className="row small pair-line">
      <span className="muted" style={{ minWidth: 64 }}>{dateShort(t.date)}</span>
      <span className="muted" style={{ minWidth: 110 }}>{acc(t.accountId)?.name}</span>
      <span className="grow ellipsis" title={t.text}>{t.text}</span>
      <Money v={t.amount} decimals colored />
      {t.id !== a.id
        ? <button className="pair-x" disabled={others.length < 2} title={others.length < 2 ? 'Der skal være mindst én at parre med' : 'Fravælg'} aria-label={`Fravælg ${t.text}`} onClick={() => setOthers(otherIds.filter((id) => id !== t.id))}>✕</button>
        : <span className="pair-x" aria-hidden />}
    </div>
  );
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal card pair-modal" role="dialog" aria-label="Par transaktioner" onMouseDown={(ev) => ev.stopPropagation()}>
        <div className="card-head">
          <h2 className="grow">Par {all.length > 2 ? `${all.length} transaktioner` : 'transaktionerne'}</h2>
          <button className="btn sm ghost" onClick={close} aria-label="Luk">✕</button>
        </div>
        {all.map((t) => <div key={t.id}>{line(t)}</div>)}
        {canAdd && (
          <div className="row small pair-add">
            <SearchCombo className="sm grow" options={addOptions} value={undefined} placeholder="＋ Tilføj flere…" searchPlaceholder="Søg dato, tekst eller beløb…"
              ariaLabel="Tilføj en transaktion" emptyText="Ingen transaktion matcher" onChange={(id) => { if (id) setOthers([...otherIds, id]); }} />
            <button className="btn sm ghost" onClick={backToList} title="Luk vinduet og vælg videre ved at klikke i listen – det valgte bevares">← Vælg i listen</button>
          </div>
        )}
        <div className="row pair-sum">
          <b>{all.length} transaktioner</b>
          <span className="spacer" />
          <DiffPill sum={sum} />
        </div>

        <ClassEditor value={cls} onChange={(c) => setCls(c)} amount={zero ? a.amount : sum} accountId={a.accountId} compact />

        {!internal && !zero && cls.categoryId && <p className="small muted" style={{ margin: 0 }}>Kun forskellen tæller i kategorien.</p>}
        {canWriteOff && (
          <div className="row small pair-writeoff">
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={writeOff} onChange={(ev) => setWriteOff(ev.target.checked)} /> Afskriv forskellen</label>
            {writeOff
              ? <CategoryCombo className="sm" value={writeOffCat} onChange={setWriteOffCat} primaryKind={sum < 0 ? 'expense' : 'income'} placeholder="som …" />
              : <span className="muted">{target?.kind === 'tracked' ? `ellers bliver den stående på ${target.name}` : ''}</span>}
          </div>
        )}

        <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
          <button className="btn sm" onClick={close}>Annullér</button>
          <button className="btn sm primary" disabled={!ok} onClick={save}>⇄ Par (Enter)</button>
        </div>
      </div>
    </div>
  );
}
