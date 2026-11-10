import { useEffect, useState } from 'react';
import { dateShort } from '../../domain/format';
import type { Classification, Tx } from '../../domain/types';
import { pairBank, pairOnPost, pairPlain, setManual, useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { CategoryCombo, ClassEditor, Money, isComplete } from './common';
import { linkTxs } from '../../domain/links';

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
  return <PairDialogInner key={`${draft.pick.txId}|${draft.otherId}`} />;
}

function PairDialogInner() {
  const e = useEngine();
  const period = usePeriod();
  const draft = useStore((s) => s.pairDraft)!;
  const close = () => useStore.getState().setPairDraft(undefined);
  const { pick, otherId } = draft;
  const a = e.txById.get(pick.txId);
  const b = e.txById.get(otherId);
  const sum = (a?.amount ?? 0) + (b?.amount ?? 0); // fra bankens side
  // Samme valg som i kategoriseringen – forudfyldt med det, en af dem allerede er.
  const [cls, setCls] = useState<Classification>(() => {
    if (pick.mode === 'bank' && a && b) return { type: 'internal', targetAccountId: b.accountId };
    if (pick.postId) return { type: 'internal', targetAccountId: pick.postId };
    for (const t of [a, b]) {
      const l = t && e.resolved.get(t.id)?.lines.find((x) => (x.type === 'internal' && x.targetAccountId) || x.categoryId);
      if (l?.type === 'internal' && l.targetAccountId !== a?.accountId) return { type: 'internal', targetAccountId: l.targetAccountId };
      if (l?.categoryId) return { type: l.type, categoryId: l.categoryId };
    }
    return { type: sum < 0 ? 'expense' : 'income' };
  });
  const [writeOff, setWriteOff] = useState(false);
  const [writeOffCat, setWriteOffCat] = useState<string>();
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
    if (!internal) pairPlain(a.id, b.id, cls.categoryId!);
    else if (target?.kind === 'tracked') pairOnPost(period, target.id, a.id, b.id, wo);
    else if (target && (target.id === a.accountId || target.id === b.accountId || target.kind === 'bank')) pairBank(a.id, b.id, wo);
    else { setManual([a.id, b.id], cls); useStore.getState().update((d) => linkTxs(d, a.id, b.id)); }
    close();
  };
  const line = (t: Tx) => (
    <div className="row small pair-line">
      <span className="muted" style={{ minWidth: 64 }}>{dateShort(t.date)}</span>
      <span className="muted" style={{ minWidth: 110 }}>{acc(t.accountId)?.name}</span>
      <span className="grow ellipsis" title={t.text}>{t.text}</span>
      <Money v={t.amount} decimals colored />
    </div>
  );
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal card pair-modal" role="dialog" aria-label="Par transaktioner" onMouseDown={(ev) => ev.stopPropagation()}>
        <div className="card-head">
          <h2 className="grow">Par transaktionerne</h2>
          <button className="btn sm ghost" onClick={close} aria-label="Luk">✕</button>
        </div>
        {line(a)}
        {line(b)}
        <div className="row pair-sum">
          <b>Forskel</b>
          <span className="spacer" />
          {zero ? <span className="chip user">✓ Går op</span> : <b><Money v={sum} decimals signed /></b>}
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
          <button className="btn sm primary" disabled={!ok} onClick={save}>⇄ Par</button>
        </div>
      </div>
    </div>
  );
}
