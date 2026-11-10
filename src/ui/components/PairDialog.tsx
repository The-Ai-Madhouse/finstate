import { useEffect, useState } from 'react';
import { dateShort, kr } from '../../domain/format';
import type { Tx } from '../../domain/types';
import { pairBank, pairOnPost, pairPlain, useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { CategoryCombo, Money, SearchCombo } from './common';
import { withAccountInPeriods } from '../../domain/accountTypes';
import { uid } from '../../domain/util';

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
  const update = useStore((s) => s.update);
  const close = () => useStore.getState().setPairDraft(undefined);
  const { pick, otherId } = draft;
  const a = e.txById.get(pick.txId);
  const b = e.txById.get(otherId);
  const lines = (t?: Tx) => (t ? e.resolved.get(t.id)?.lines ?? [] : []);
  const tracked = e.data.accounts.filter((x) => x.kind === 'tracked' && !x.archived);
  // Står en af dem allerede på en post (fx "Jonas skylder mig"), er det oplagt at afstemme dér.
  const postOf = (t?: Tx) => lines(t).find((l) => l.type === 'internal' && tracked.some((x) => x.id === l.targetAccountId))?.targetAccountId;
  const catOf = (t?: Tx) => lines(t).find((l) => l.categoryId)?.categoryId;
  const initialPost = pick.postId ?? postOf(a) ?? postOf(b);
  const [kind, setKind] = useState<'post' | 'plain'>(initialPost ? 'post' : 'plain');
  const [postId, setPostId] = useState<string | undefined>(initialPost);
  const [categoryId, setCategoryId] = useState<string | undefined>(() => catOf(a) ?? catOf(b));
  const [rest, setRest] = useState<'later' | 'writeoff' | 'carry'>('later');
  if (!a || !b || !period) return null;
  const acc = (id: string) => e.data.accounts.find((x) => x.id === id)?.name ?? '';
  const sum = a.amount + b.amount; // fra bankens side
  const zero = sum === 0;
  const restKind = sum < 0 ? 'udgift' : 'indtægt';
  const bank = pick.mode === 'bank';
  const post = postId ? e.data.accounts.find((x) => x.id === postId) : undefined;
  const needsCategory = bank ? !zero : kind === 'plain' || (!zero && rest === 'writeoff');
  const ok = (bank || kind === 'plain' || !!post) && (!needsCategory || !!categoryId);
  const next = /^\d{4}$/.test(period.name.trim()) ? String(Number(period.name.trim()) + 1) : 'næste periode';
  const createPost = (name: string) => {
    const id = uid('acc');
    // Lægger du ud (penge ud), skylder den anden dig: en aktiv. Ellers en passiv.
    const side = sum <= 0 ? 'asset' : 'liability';
    update((d) => withAccountInPeriods({ ...d, accounts: [...d.accounts, { id, name: name.trim(), kind: 'tracked', side, aliases: [] }] }, id, period.id));
    setPostId(id);
  };
  const save = () => {
    if (!ok) return;
    if (bank) pairBank(a.id, b.id, zero ? undefined : categoryId);
    else if (kind === 'post' && post) pairOnPost(period, post.id, a.id, b.id, !zero && rest === 'writeoff' ? categoryId : undefined, !zero && rest === 'carry');
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
          <h2 className="grow">{bank ? 'Par overførslen' : 'Par transaktionerne'}</h2>
          <button className="btn sm ghost" onClick={close} aria-label="Luk">✕</button>
        </div>
        {line(a)}
        {line(b)}
        <div className="row pair-sum">
          <b>I alt</b>
          <span className="spacer" />
          {zero ? <span className="chip user">✓ Går op</span> : <span className="chip review">Forskel: {kr(Math.abs(sum))} {restKind}</span>}
          <b><Money v={sum} decimals signed /></b>
        </div>

        {bank ? (
          <div className="pair-choice">
            <p className="small ink2">Begge bliver en intern overførsel mellem {acc(a.accountId)} og {acc(b.accountId)}.</p>
            {!zero && (
              <label className="field">Forskellen ({kr(Math.abs(sum))}, fx et gebyr) bogføres som
                <CategoryCombo className="sm" value={categoryId} onChange={setCategoryId} primaryKind={sum < 0 ? 'expense' : 'income'} placeholder="vælg kategori" />
              </label>
            )}
          </div>
        ) : (
          <>
            <div className="seg pair-kind" role="radiogroup" aria-label="Hvordan skal de bogføres?">
              <button role="radio" aria-checked={kind === 'post'} className={kind === 'post' ? 'on plain' : ''} onClick={() => setKind('post')} title="Fx et udlæg og tilbagebetalingen: de flytter penge til/fra en post på din balance og afstemmes dér">Intern – afstemmes på en post</button>
              <button role="radio" aria-checked={kind === 'plain'} className={kind === 'plain' ? 'on plain' : ''} onClick={() => setKind('plain')} title="Fx et køb og en refusion: begge bogføres i én kategori">Udgift/indtægt</button>
            </div>

            {kind === 'post' ? (
              <div className="pair-choice">
                <label className="field">Post
                  <SearchCombo className="sm" value={postId} placeholder="vælg post – fx Jonas skylder mig" searchPlaceholder="Søg post…" ariaLabel="Post til afstemning" emptyText="Ingen post matcher"
                    options={tracked.map((x) => ({ id: x.id, label: x.name }))} onChange={setPostId}
                    onCreate={(q) => q.trim() && createPost(q)} createLabel={(q) => (q ? `+ Opret "${q}" som ny post` : '+ Ny post…')} />
                </label>
                {post && <p className="small ink2">Begge bliver "Intern → {post.name}", og {post.name} afstemmes i {period.name}.</p>}
                {!zero && post && (
                  <>
                    <div className="small"><b>Forskellen på {kr(Math.abs(sum))}</b></div>
                    <label className="row small"><input type="radio" checked={rest === 'later'} onChange={() => setRest('later')} /> Afgør senere – den står som uafklaret i afstemningen af {post.name}</label>
                    <label className="row small"><input type="radio" checked={rest === 'writeoff'} onChange={() => setRest('writeoff')} /> Afskriv den som {restKind} – afskrivningen lægges i samme gruppe på {post.name}</label>
                    {rest === 'writeoff' && <CategoryCombo className="sm" value={categoryId} onChange={setCategoryId} primaryKind={sum < 0 ? 'expense' : 'income'} placeholder="vælg kategori" />}
                    <label className="row small"><input type="radio" checked={rest === 'carry'} onChange={() => setRest('carry')} /> Tag den med til {next} – den bliver stående på {post.name}</label>
                  </>
                )}
              </div>
            ) : (
              <div className="pair-choice">
                <label className="field">{zero ? 'Bogfør begge under' : `Hvor hører ${restKind}en på ${kr(Math.abs(sum))} hjemme?`}
                  <CategoryCombo className="sm" value={categoryId} onChange={setCategoryId} primaryKind={sum < 0 ? 'expense' : 'income'} placeholder="vælg kategori" />
                </label>
                <p className="small muted">
                  {zero ? 'De går op – begge bogføres i kategorien, så de ikke påvirker resultatet.' : `Begge bogføres i kategorien, så kun forskellen (${kr(Math.abs(sum))}) tæller som ${restKind}.`}
                </p>
              </div>
            )}
          </>
        )}

        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button className="btn sm" onClick={close}>Annullér</button>
          <button className="btn sm primary" disabled={!ok} onClick={save}>⇄ Par</button>
        </div>
      </div>
    </div>
  );
}
