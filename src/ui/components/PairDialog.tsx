import { useEffect, useState } from 'react';
import { dateShort, kr } from '../../domain/format';
import type { Tx } from '../../domain/types';
import { pairBank, pairOnPost, pairPlain, useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { CategoryCombo, Money } from './common';

/**
 * Par to transaktioner. Går de ikke op, skriver man, hvor resten hører hjemme:
 *  · på en post (fx "Jonas skylder mig"): resten bliver stående på posten – eller afskrives som udgift/indtægt
 *  · mellem dine konti: resten (fx et gebyr) bogføres i en kategori
 *  · almindelige transaktioner (fx udlæg og indbetaling): begge bogføres i én kategori, så kun resten tæller
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
  const post = pick.postId ? e.data.accounts.find((x) => x.id === pick.postId) : undefined;
  // Forslag til kategori: den, en af dem allerede står i.
  const catOf = (t?: Tx) => (t ? e.resolved.get(t.id)?.lines.find((l) => l.categoryId)?.categoryId : undefined);
  const [categoryId, setCategoryId] = useState<string | undefined>(() => catOf(a) ?? catOf(b));
  const [restOnPost, setRestOnPost] = useState(true);
  if (!a || !b || !period) return null;
  const acc = (id: string) => e.data.accounts.find((x) => x.id === id)?.name ?? '';
  const sum = a.amount + b.amount; // fra bankens side
  const zero = sum === 0;
  const restKind = sum < 0 ? 'udgift' : 'indtægt';
  const needsCategory = pick.mode === 'plain' || (pick.mode === 'bank' && !zero) || (pick.mode === 'post' && !zero && !restOnPost);
  const ok = !needsCategory || !!categoryId;
  const save = () => {
    if (!ok) return;
    if (pick.mode === 'post' && post) pairOnPost(period, post.id, a.id, b.id, !zero && !restOnPost ? categoryId : undefined);
    else if (pick.mode === 'bank') pairBank(a.id, b.id, zero ? undefined : categoryId);
    else if (categoryId) pairPlain(a.id, b.id, categoryId);
    close();
  };
  const line = (t: Tx) => (
    <div className="row small pair-line">
      <span className="muted" style={{ minWidth: 64 }}>{dateShort(t.date)}</span>
      <span className="muted" style={{ minWidth: 110 }}>{acc(t.accountId)}</span>
      <span className="grow ellipsis" title={t.text}>{t.text}</span>
      <Money v={t.amount} decimals colored />
    </div>
  );
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal card pair-modal" role="dialog" aria-label="Par transaktioner" onMouseDown={(ev) => ev.stopPropagation()} onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.target as HTMLElement).getAttribute('role') !== 'combobox') save(); }}>
        <div className="card-head">
          <h2 className="grow">{pick.mode === 'post' && post ? `Par på ${post.name}` : pick.mode === 'bank' ? 'Par overførslen' : 'Par transaktionerne'}</h2>
          <button className="btn sm ghost" onClick={close} aria-label="Luk">✕</button>
        </div>
        {line(a)}
        {line(b)}
        <div className="row pair-sum">
          <b>I alt</b>
          <span className="spacer" />
          {zero ? <span className="chip user">✓ Går op</span> : <span className="chip review">Resten: {kr(Math.abs(sum))} {restKind}</span>}
          <b><Money v={sum} decimals signed /></b>
        </div>

        {pick.mode === 'post' && post && (
          <div className="pair-choice">
            <p className="small ink2">Begge bliver "Intern → {post.name}", og posten afstemmes i {period.name}.{pick.txId !== b.id && !isInternalTo(e.resolved.get(b.id)?.lines, post.id) ? ` "${b.text}" flyttes over til ${post.name}.` : ''}</p>
            {!zero && (
              <>
                <label className="row small"><input type="radio" checked={restOnPost} onChange={() => setRestOnPost(true)} /> Resten bliver stående på {post.name} ({sum < 0 ? 'mangler at blive betalt tilbage' : 'for meget'})</label>
                <label className="row small"><input type="radio" checked={!restOnPost} onChange={() => setRestOnPost(false)} /> Afskriv resten som {restKind}:</label>
                {!restOnPost && <CategoryCombo className="sm" value={categoryId} onChange={setCategoryId} primaryKind={sum < 0 ? 'expense' : 'income'} placeholder="vælg kategori" />}
              </>
            )}
          </div>
        )}
        {pick.mode === 'bank' && (
          <div className="pair-choice">
            <p className="small ink2">Begge bliver en intern overførsel mellem {acc(a.accountId)} og {acc(b.accountId)}.</p>
            {!zero && (
              <label className="field">Resten ({kr(Math.abs(sum))}, fx et gebyr) bogføres som
                <CategoryCombo className="sm" value={categoryId} onChange={setCategoryId} primaryKind={sum < 0 ? 'expense' : 'income'} placeholder="vælg kategori" />
              </label>
            )}
          </div>
        )}
        {pick.mode === 'plain' && (
          <div className="pair-choice">
            <label className="field">{zero ? 'Bogfør begge under' : `Hvor hører ${restKind}en på ${kr(Math.abs(sum))} hjemme?`}
              <CategoryCombo className="sm" value={categoryId} onChange={setCategoryId} primaryKind={sum < 0 ? 'expense' : 'income'} placeholder="vælg kategori" />
            </label>
            <p className="small muted">
              {zero
                ? 'De går op – begge bogføres i kategorien, så de ikke påvirker resultatet.'
                : `Begge bogføres i kategorien, så kun resten (${kr(Math.abs(sum))}) tæller som ${restKind}.`}
            </p>
          </div>
        )}

        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button className="btn sm" onClick={close}>Annullér</button>
          <button className="btn sm primary" disabled={!ok} onClick={save}>⇄ Par</button>
        </div>
      </div>
    </div>
  );
}

const isInternalTo = (lines: { type: string; targetAccountId?: string }[] | undefined, postId: string) =>
  !!lines?.some((l) => l.type === 'internal' && l.targetAccountId === postId);
