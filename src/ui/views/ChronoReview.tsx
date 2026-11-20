import { useEffect, useMemo, useRef, useState } from 'react';
import { NEEDS_REVIEW, clsOfLine, type Resolved } from '../../domain/classify';
import { dateShort } from '../../domain/format';
import { normalizeText } from '../../domain/normalize';
import type { Classification, Tx } from '../../domain/types';
import { setManual, useEngine, usePeriod } from '../../store/actions';
import { inPeriod } from '../../domain/engine';
import { SimilarDialog } from '../components/SimilarDialog';
import { SplitDialog } from '../components/SplitDialog';
import { ClassEditor, Empty, internalTargetName, Money, linkTargetProps, SourceChip, TYPE_KEYS, TxNotes, categoryLabel, isComplete, withTypeKey, InfoBox } from '../components/common';
import { Confetti } from '../components/Confetti';
import { useStore } from '../../store/store';
import { UNDO_KEY, undo } from '../components/Undo';
import { useFocusIntent } from '../components/NavFocus';
import { hasUncategorized } from '../../domain/txfilter';

const clsOf = (r: Resolved): Classification => clsOfLine(r.lines[0]);
const similarKey = (t: Tx) => `${normalizeText(t.text) || t.text}|${t.amount > 0 ? 'in' : 'out'}`;

/** Ligger den første ubehandlede række over, under eller inden for skærmen? */
function useNextPendingDirection(dep: number): 'up' | 'down' | 'visible' {
  const [dir, setDir] = useState<'up' | 'down' | 'visible'>('visible');
  useEffect(() => {
    const scroller = document.querySelector('.main');
    const calc = () => {
      const el = document.querySelector<HTMLElement>('[data-pending="true"]');
      if (!el) return setDir('visible');
      const r = el.getBoundingClientRect();
      setDir(r.bottom < 170 ? 'up' : r.top > window.innerHeight ? 'down' : 'visible');
    };
    calc();
    scroller?.addEventListener('scroll', calc, { passive: true });
    window.addEventListener('resize', calc);
    return () => { scroller?.removeEventListener('scroll', calc); window.removeEventListener('resize', calc); };
  }, [dep]);
  return dir;
}

/** Flyt fokus til næste række, der mangler en afgørelse (efter React har opdateret). */
function focusNextPending(fromId: string) {
  setTimeout(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-txrow]')];
    const i = rows.findIndex((r) => r.dataset.txrow === fromId);
    const next = rows.slice(i + 1).find((r) => r.dataset.pending === 'true') ?? rows.find((r) => r.dataset.pending === 'true');
    if (!next) return;
    next.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Færre tastetryk: stil markøren direkte i kategorisøgningen (eller personfeltet), så man kan skrive med det samme.
    const field = next.querySelector<HTMLElement>('.combo-input, input[aria-label="Person"]');
    (field ?? next).focus({ preventScroll: true });
  }, 60);
}

/** Stil markøren i rækkens kategorisøgning (efter React har opdateret – også hvis rækken er monteret på ny). */
export function focusTxField(txId: string, attr = 'data-txrow') {
  setTimeout(() => {
    const row = document.querySelector<HTMLElement>(`[${attr}="${CSS.escape(txId)}"]`);
    row?.querySelector<HTMLElement>('.combo-input, input[aria-label="Person"]')?.focus();
  }, 60);
}

/**
 * Kronologisk gennemgang (ældste først) med brugerens kommentar fremme.
 * En afgørelse kan gemmes som regel, så senere ens poster klares automatisk –
 * de bliver stående i listen (markeret), så rækkefølgen ikke hopper.
 */
/**
 * txs: det der vises (efter søgning). scope: periode + konto – bestemmer fremskridt og fejring,
 * så en søgning ikke får det til at se ud, som om alt er færdigt. Komponenten genmonteres pr. omfang
 * (key i LedgerView), så et allerede færdigt omfang ikke fejres igen.
 */
export function ChronoReview({ txs, scope, searching }: { txs: Tx[]; scope: Tx[]; searching?: boolean }) {
  const e = useEngine();
  const [hideDone, setHideDone] = useState(false);
  // Linket hertil til en bestemt transaktion: vis den, også hvis den er afgjort (fremhævningen klares af NavFocus).
  useFocusIntent('ledger', (f) => { if (!f.quiet && (f.key?.startsWith('tx:') || f.key === 'ledger:uncat')) setHideDone(false); });
  // Rækkefølgen kommer fra filterlinjen (standard: dato, ældst først).
  const sorted = txs;

  // Alle transaktioner (i hele bogføringen) pr. "lignende"-nøgle – til "Lignende"-vinduet.
  const byKey = useMemo(() => {
    const m = new Map<string, Tx[]>();
    for (const t of e.data.txs) {
      if (t.date <= e.data.settings.bookStart) continue;
      const k = similarKey(t);
      (m.get(k) ?? m.set(k, []).get(k)!).push(t);
    }
    return m;
  }, [e]);

  const isPendingTx = (t: Tx) => NEEDS_REVIEW.has(e.resolved.get(t.id)!.source);
  const pending = scope.filter(isPendingTx);
  const shown = hideDone ? sorted.filter(isPendingTx) : sorted;
  const done = scope.length - pending.length;
  const pct = scope.length ? Math.round((done / scope.length) * 100) : 0;
  // Hvor mange er klaret i denne omgang (inkl. dem dine regler klarede automatisk)?
  const startPending = useRef(pending.length);
  const handled = Math.max(0, startPending.current - pending.length);
  const nextDir = useNextPendingDirection(pending.length);

  // --- Gamification: små belønninger undervejs og en fejring til sidst.
  const startTime = useRef(Date.now());
  const startRules = useRef(e.data.rules.length);
  const [decisions, setDecisions] = useState(0);
  const [flash, setFlash] = useState<string>();
  const [pop, setPop] = useState<{ n: number; text: string; big?: boolean }>();
  const [celebrate, setCelebrate] = useState(false);
  const [confetti, setConfetti] = useState(false);
  const prevPct = useRef(pct);
  const prevPending = useRef(pending.length);
  const showPop = (text: string, big = false) => setPop((p) => ({ n: (p?.n ?? 0) + 1, text, big }));

  // Hvor man har været: efter en afgørelse hopper markøren videre – "← Tilbage" fører én tilbage.
  const [trail, setTrail] = useState<string[]>([]);
  const goBack = () => {
    const id = trail[trail.length - 1];
    if (!id) return;
    setTrail((t) => t.slice(0, -1));
    const row = document.querySelector<HTMLElement>(`[data-txrow="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // En afgjort række har intet kategorifelt – så får rækken selv fokus (Enter/"Ret" for at ændre den).
    (row.querySelector<HTMLElement>('.combo-input, input[aria-label="Person"]') ?? row).focus({ preventScroll: true });
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? undefined : f)), 1200);
  };
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  const canUndo = useStore((s) => s.undoStack.length > 0);

  const onCommit = (txId: string, coveredByRule: number) => {
    setTrail((t) => [...t.filter((x) => x !== txId).slice(-49), txId]);
    setDecisions((d) => d + 1);
    setFlash(txId);
    setTimeout(() => setFlash((f) => (f === txId ? undefined : f)), 900);
    showPop(coveredByRule > 0 ? `+1 · +${coveredByRule} via din regel` : '+1');
  };

  useEffect(() => {
    // Milepæle (kun når man krydser dem i denne omgang).
    const crossed = [50, 75, 90].find((m) => prevPct.current < m && pct >= m && pct < 100);
    if (crossed) setTimeout(() => showPop(crossed === 50 ? 'Halvvejs! 💪' : crossed === 75 ? 'Tre fjerdedele – godt gået!' : 'Næsten i mål!', true), 500);
    // Fejring: fra "noget tilbage" til "intet tilbage" i denne omgang.
    if (prevPending.current > 0 && pending.length === 0) {
      setCelebrate(true);
      setConfetti(true);
      // Man står typisk nederst i listen – vis afslutningskortet.
      setTimeout(() => document.querySelector('.done-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
    }
    prevPct.current = pct;
    prevPending.current = pending.length;
  }, [pct, pending.length]);

  // "N" = gå til næste ubehandlede (når man ikke skriver i et felt).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement).tagName;
      if ((ev.key === 'n' || ev.key === 'N') && !ev.metaKey && !ev.ctrlKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
        ev.preventDefault();
        focusNextPending('');
      }
      // "B" = tilbage til den, man lige har afgjort.
      if ((ev.key === 'b' || ev.key === 'B') && !ev.metaKey && !ev.ctrlKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
        ev.preventDefault();
        goBackRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rulesOn = e.data.settings.rulesEnabled === true;
  if (!scope.length) return <Empty>Ingen transaktioner i perioden.</Empty>;

  const minutes = Math.max(1, Math.round((Date.now() - startTime.current) / 60000));
  const auto = Math.max(0, handled - decisions);
  const newRules = Math.max(0, e.data.rules.length - startRules.current);

  return (
    <div className="card">
      {confetti && <Confetti onDone={() => setConfetti(false)} />}
      {pending.length === 0 && (
        <div className={`done-card ${celebrate ? 'celebrate' : ''}`}>
          <div className="done-badge" aria-hidden>✓</div>
          <div className="grow">
            <h2>{celebrate ? 'Alt er gennemgået!' : 'Perioden er færdigkategoriseret'}</h2>
            <p className="ink2" style={{ marginTop: 4 }}>
              Alle {scope.length} transaktioner har en afgørelse{rulesOn ? ' fra dig eller dine regler' : ' fra dig'}.
            </p>
            {celebrate && (
              <div className="done-stats">
                <div><b>{decisions}</b><span>beslutninger truffet</span></div>
                {rulesOn && <div><b>{auto}</b><span>klaret af dine regler</span></div>}
                {rulesOn && <div><b>{newRules}</b><span>nye regler til næste gang</span></div>}
                <div><b>{minutes} min</b><span>brugt</span></div>
              </div>
            )}
            {celebrate && rulesOn && auto > 0 && (
              <p className="small ink2" style={{ marginTop: 8 }}>
                Dine regler sparede dig for {auto} beslutninger i dag – og de virker også næste år.
              </p>
            )}
          </div>
          <button className="btn primary" onClick={() => useStore.getState().setView('transfers')}>Næste: Overførsler →</button>
        </div>
      )}
      <div className="review-bar" role="status" aria-live="polite">
        {pop && <span key={pop.n} className={`pop ${pop.big ? 'big' : ''}`}>{pop.text}</span>}
        <div className="grow">
          <div className="row" style={{ gap: 10 }}>
            <b>{pending.length ? `${pending.length} tilbage` : 'Alt er afgjort 🎉'}</b>
            <span className="ink2 small">{done} af {scope.length} afgjort · {pct} %</span>{searching && <span className="chip" title="Filtrene ændrer kun, hvad du ser – ikke tællingen">filtreret: viser {sorted.length}</span>}
            {handled > 0 && <span className="chip user">+{handled} i denne omgang</span>}
          </div>
          <div className="bigprogress" aria-hidden><div style={{ width: `${pct}%` }} /></div>
          <InfoBox label="Genveje">
            <b>Skriv</b> for at søge kategori/post · <b>↑/↓</b> vælg · <b>Enter</b> gem og videre · <b>{UNDO_KEY}</b> fortryd · <b>B</b> tilbage til forrige · <b>1</b>/<b>2</b> (eller Alt+1/2) indtægt-udgift/intern · <b>N</b> næste ubehandlede
          </InfoBox>
        </div>
        <label className="row small ink2"><input type="checkbox" checked={hideDone} onChange={(ev) => setHideDone(ev.target.checked)} /> Skjul afgjorte</label>
        <button className="btn sm" disabled={!trail.length} onClick={goBack} title="Tilbage til den, du lige afgjorde (tast B)">← Tilbage</button>
        <button className="btn sm" disabled={!canUndo} onClick={() => undo()} title={`Fortryd den seneste ændring (${UNDO_KEY})`}>↶ Fortryd</button>
        {pending.length > 0 && (
          <button className="btn primary" onClick={() => focusNextPending('')} title="Tast N">
            Næste ubehandlede {nextDir === 'up' ? '↑' : nextDir === 'down' ? '↓' : '→'}
          </button>
        )}
      </div>
      {!shown.length ? <Empty>{searching ? 'Ingen transaktioner matcher filtrene.' : 'Alt i perioden er afgjort. 🎉'}</Empty> : (
        <div className="chrono-list">
          {shown.map((t) => {
            const r = e.resolved.get(t.id)!;
            const similar = (byKey.get(similarKey(t)) ?? []).filter((x) => x.id !== t.id);
            // Nøglen nulstiller kladden, når transaktionens klassifikation ændres udefra.
            return <ChronoRow key={`${t.id}|${r.source}|${JSON.stringify(r.lines)}`} tx={t} r={r} similar={similar} flash={flash === t.id} onCommit={onCommit} />;
          })}
        </div>
      )}
    </div>
  );
}

function ChronoRow({ tx, r, similar, flash, onCommit }: { tx: Tx; r: Resolved; similar: Tx[]; flash: boolean; onCommit: (txId: string, coveredByRule: number) => void }) {
  const e = useEngine();
  const isPending = NEEDS_REVIEW.has(r.source);
  const [editing, setEditing] = useState(false);
  // En opdelt transaktion rettes som opdeling – "Erstat med én kategori" er et bevidst valg.
  const [replaceSplit, setReplaceSplit] = useState(false);
  const isSplit = r.lines.length > 1;
  const [cls, setCls] = useState<Classification>(clsOf(r));
  const [showSimilar, setShowSimilar] = useState(false);
  const [showSplit, setShowSplit] = useState(false);
  const open = isPending || editing;
  const ready = isComplete(cls);
  const rule = r.ruleId ? e.data.rules.find((x) => x.id === r.ruleId) : undefined;
  const ruleOrigin = rule ? e.data.txs.find((x) => x.id !== tx.id && normalizeText(x.text) === rule.pattern && x.date < tx.date) : undefined;

  const commit = (override?: Classification) => {
    const c = override ?? cls;
    if (!isComplete(c)) return;
    setManual([tx.id], c);
    if (isPending) onCommit(tx.id, 0);
    setEditing(false);
    setReplaceSplit(false);
    focusNextPending(tx.id);
  };

  const onKey = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (ev.target as HTMLElement).tagName;
    const onRow = ev.target === ev.currentTarget;
    if (ev.key === 'Enter' && tag !== 'SELECT' && tag !== 'BUTTON' && open) { ev.preventDefault(); commit(); return; }
    if (!onRow) return;
    const sib = (dir: 'next' | 'prev') => (dir === 'next' ? ev.currentTarget.nextElementSibling : ev.currentTarget.previousElementSibling) as HTMLElement | null;
    if (ev.key === 'ArrowDown') { sib('next')?.focus(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { sib('prev')?.focus(); ev.preventDefault(); }
    else if (TYPE_KEYS[ev.key] && open) {
      setCls(withTypeKey(cls, TYPE_KEYS[ev.key], tx.amount, e.data.categories));
      const row = ev.currentTarget;
      setTimeout(() => row.querySelector<HTMLInputElement>('.combo-input')?.focus(), 0);
    }
  };

  const acc = e.data.accounts.find((a) => a.id === tx.accountId);
  // "⇄ Par…": mens man vælger den anden, kan rækken klikkes.
  const lt = linkTargetProps(useStore((st) => st.linkPick), tx.id);
  const period = usePeriod();
  // Knappen tæller kun lignende i det aktuelle financial statement (andre perioder kan vises i vinduet).
  const nSimilar = period ? similar.filter((t) => inPeriod(t, period)).length : similar.length;
  const similarLabel = `Lignende (${nSimilar}${nSimilar < similar.length ? `+${similar.length - nSimilar}` : ''})`;
  return (
    <div className={`chrono-row ${open ? 'open' : 'done'} ${flash ? 'flash' : ''} ${lt.className}`} tabIndex={0} data-txrow={tx.id} data-pending={isPending}
      data-focus-field={isPending ? '.combo-input, input[aria-label="Person"]' : undefined}
      data-focus={[`tx:${tx.id}`, isPending && 'ledger:pending', hasUncategorized(r) && 'ledger:uncat'].filter(Boolean).join(' ')} onKeyDown={onKey}
      title={lt.title} onClickCapture={lt.onClickCapture}>
      <div className="small ink2">{dateShort(tx.date)}<div className="muted ellipsis">{acc?.name}</div></div>
      <div style={{ minWidth: 0 }}>
        <div className="ellipsis" title={tx.text}><b>{tx.text}</b></div>
        <TxNotes tx={tx} />
        {(tx.bankCategory || tx.bankSubcategory) && <div className="small muted ellipsis">Bank: {tx.bankCategory}{tx.bankSubcategory ? ` › ${tx.bankSubcategory}` : ''}</div>}
      </div>
      <div className="num"><Money v={tx.amount} decimals colored /></div>
      {open && isSplit && !replaceSplit ? (
        <SplitBreakdown r={r} total={tx.amount} source={isPending ? r.source : undefined} onEdit={() => setShowSplit(true)} onReplace={() => { setReplaceSplit(true); focusTxField(tx.id); }} />
      ) : isSplit && !open ? (
        <SplitBreakdown r={r} total={tx.amount} source={r.source} />
      ) : open ? (
        <div className="col" style={{ gap: 4 }}>
          <ClassEditor value={cls} onChange={setCls} amount={tx.amount} accountId={tx.accountId} txId={tx.id} compact onCommit={(c) => { setCls(c); commit(c); }} />
          {isPending && <div className="small muted">Forslag: <SourceChip source={r.source} /></div>}
          {editing && isSplit && <div className="small neg">Gemmer du, erstattes opdelingen i {r.lines.length} dele af én kategori.</div>}
        </div>
      ) : (
        <div className="small row" style={{ gap: 6 }}>
          <SourceChip source={r.source} />
          <span>{r.lines.map((l) => (l.type === 'outlay' ? `Udlæg · ${l.counterparty}` : l.type === 'internal' ? `Intern${internalTargetName(e.data.accounts, l) ? ` → ${internalTargetName(e.data.accounts, l)}` : ''}` : categoryLabel(e.data.categories, l.categoryId) || 'ukategoriseret')).join(' + ')}</span>
          {r.source === 'rule' && ruleOrigin && <span className="muted">· som {dateShort(ruleOrigin.date)}</span>}
        </div>
      )}
      <div className="row" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
        {open ? (
          <>
            {similar.length > 0 && (
              <button className="btn sm ghost" title="Se alle transaktioner med samme tekst – vælg hvilke og hvad de skal være" onClick={() => setShowSimilar(true)}>{similarLabel}</button>
            )}
            {!isSplit && <button className="btn sm ghost" title="Del beløbet op, fx en løn = indtægt + indbetaling til pension" onClick={() => setShowSplit(true)}>Opdel</button>}
            {editing && <button className="btn sm ghost" onClick={() => { setEditing(false); setReplaceSplit(false); setCls(clsOf(r)); }}>Annullér</button>}
            {(!isSplit || replaceSplit) && <button className="btn sm primary" disabled={!ready} onClick={() => commit()}>✓ Gem</button>}
          </>
        ) : (
          <>
            {r.source === 'manual' && <button className="btn sm ghost" title="Fjern dit valg (brug regel/forslag)" onClick={() => { setManual([tx.id], undefined); focusTxField(tx.id); }}>↺</button>}
            {similar.length > 0 && <button className="btn sm ghost" title="Samme tekst – i perioden (+ andre perioder)" onClick={() => setShowSimilar(true)}>{similarLabel}</button>}
            {isSplit && <button className="btn sm ghost" onClick={() => setShowSplit(true)}>Ret opdeling</button>}
            <button className="btn sm ghost" onClick={() => { setEditing(true); focusTxField(tx.id); }}>Ret</button>
          </>
        )}
      </div>
      {showSplit && (
        <SplitDialog tx={tx} resolved={r} onClose={() => setShowSplit(false)}
          onSaved={() => { if (isPending) onCommit(tx.id, 0); setEditing(false); setReplaceSplit(false); focusNextPending(tx.id); }} />
      )}
      {showSimilar && (
        <SimilarDialog tx={tx} similar={similar} initial={cls} onClose={() => setShowSimilar(false)}
          onApplied={(n) => { if (isPending) onCommit(tx.id, n - 1); setEditing(false); focusNextPending(tx.id); }} />
      )}
    </div>
  );
}

const TYPE_SHORT: Record<string, string> = { income: 'Indtægt', expense: 'Udgift', internal: 'Intern', outlay: 'Udlæg' };

/**
 * En opdelt transaktion: hver del på sin egen linje med type, hvad den er, og beløb –
 * plus en lille fordelingsbjælke og summen, så man kan se, at det går op.
 */
function SplitBreakdown({ r, total, source, onEdit, onReplace }: { r: Resolved; total: number; source?: Resolved['source']; onEdit?: () => void; onReplace?: () => void }) {
  const e = useEngine();
  const whole = r.lines.reduce((s, l) => s + Math.abs(l.amount), 0) || 1;
  const what = (l: Resolved['lines'][number]) =>
    l.type === 'internal' ? `→ ${internalTargetName(e.data.accounts, l) ?? 'vælg post'}`
      : l.type === 'outlay' ? l.counterparty ?? ''
      : categoryLabel(e.data.categories, l.categoryId) || 'ukategoriseret';
  const sum = r.lines.reduce((s, l) => s + l.amount, 0);
  return (
    <div className="split-bd">
      <div className="split-bd-head">
        <b>Opdelt i {r.lines.length} dele</b>
        {source && source !== 'split' && <SourceChip source={source} />}
        <span className="spacer" />
        {onEdit && <button className="btn sm" onClick={onEdit}>Ret opdeling</button>}
        {onReplace && <button className="btn sm ghost" onClick={onReplace}>Erstat med én kategori</button>}
      </div>
      <div className="split-bar" aria-hidden>
        {r.lines.map((l, i) => <span key={i} data-t={l.type} style={{ flexGrow: Math.abs(l.amount) / whole }} />)}
      </div>
      {r.lines.map((l, i) => (
        <div key={i} className="split-bd-line">
          <span className="split-type" data-t={l.type}>{TYPE_SHORT[l.type] ?? l.type}</span>
          <span className={`ellipsis ${!l.categoryId && l.type !== 'internal' && l.type !== 'outlay' ? 'neg' : ''}`} title={what(l)}>{what(l)}</span>
          <span className="num"><Money v={l.amount} decimals /></span>
        </div>
      ))}
      <div className="split-bd-sum">
        <span>I alt</span>
        <span className="num"><Money v={sum} decimals />{sum === total ? <span className="pos"> ✓</span> : <span className="neg"> ≠ <Money v={total} decimals /></span>}</span>
      </div>
    </div>
  );
}
