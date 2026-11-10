import { NoPeriod } from '../components/PeriodPrompt';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NEEDS_REVIEW, clsOfLine, type Resolved } from '../../domain/classify';
import { inPeriod } from '../../domain/engine';
import { dateShort, kr } from '../../domain/format';
import { normalizeText } from '../../domain/normalize';
import type { Classification, Tx } from '../../domain/types';
import { useStore, type LedgerFilter } from '../../store/store';
import { activeFilterCount, filterTxs } from '../../domain/txfilter';
import { ChronoReview, focusTxField } from './ChronoReview';
import { SplitDialog } from '../components/SplitDialog';
import { addDays } from '../../domain/util';
import { defaultCategories } from '../../domain/defaults';
import { saveRule, setManual, useEngine, usePeriod } from '../../store/actions';
import { AccountSelect, CategoryCombo, internalTargetName, LinkPickBanner, linkTargetProps, ClassEditor, TYPE_KEYS, TxNotes, isComplete, withTypeKey, Empty, Money, SourceChip, categoryLabel, InfoBox } from '../components/common';

const clsOf = (r: Resolved): Classification => clsOfLine(r.lines[0]);

/** Kategorisering hører til et financial statement – uden periode vises startkortet. */
export function LedgerView() {
  return usePeriod() ? <LedgerInner /> : <NoPeriod />;
}

function LedgerInner() {
  type Tab = 'chrono' | 'review' | 'all';
  const [tab, setTabState] = useState<Tab>(() => {
    try { return (localStorage.getItem('finstate:ledgerTab') as Tab) || 'chrono'; } catch { return 'chrono'; }
  });
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem('finstate:ledgerTab', t); } catch { /* ok */ } };
  // Linket hertil til en bestemt transaktion: vis den i gennemgangen.
  const focusTxId = useStore((s) => s.focusTxId);
  // Filtre ligger i store, så de er der stadig, når man kommer tilbage.
  const filter = useStore((s) => s.ledgerFilter);
  const setPeriod = useStore((s) => s.setPeriod);
  const e = useEngine();
  const period = usePeriod()!;
  const { data } = e;

  // Kun transaktioner i det valgte financial statement.
  const periodTxs = useMemo(() => data.txs.filter((t) => t.date > data.settings.bookStart && inPeriod(t, period)), [data, period]);
  // Omfang = periode + konto. Det bestemmer fremskridt og fejring – de øvrige filtre ændrer kun, hvad man ser.
  const scope = useMemo(() => periodTxs.filter((t) => !filter.accountId || t.accountId === filter.accountId), [periodTxs, filter.accountId]);
  const txs = useMemo(() => filterTxs(periodTxs, e.resolved, data.categories, filter), [periodTxs, e.resolved, data.categories, filter]);

  useEffect(() => {
    if (!focusTxId) return;
    setTabState('chrono');
    const t = data.txs.find((x) => x.id === focusTxId);
    if (!t) return;
    // Ligger transaktionen i et andet financial statement, så skift til det.
    if (!inPeriod(t, period)) { const p = data.periods.find((x) => inPeriod(t, x)); if (p) setPeriod(p.id); }
    // Ville filtrene skjule den, så nulstil dem (sorteringen bevares).
    const f = useStore.getState().ledgerFilter;
    if (!filterTxs([t], e.resolved, data.categories, f).length) useStore.getState().resetLedgerFilter();
  }, [focusTxId]); // eslint-disable-line react-hooks/exhaustive-deps

  const review = txs.filter((t) => NEEDS_REVIEW.has(e.resolved.get(t.id)!.source));
  const scopeReview = scope.filter((t) => NEEDS_REVIEW.has(e.resolved.get(t.id)!.source)).length;
  const update = useStore((s) => s.update);
  const excluded = data.txs.filter((t) => inPeriod(t, period) && t.date <= data.settings.bookStart).length;
  const nActive = activeFilterCount(filter);

  return (
    <div className="stack">
      <h1>Kategorisér</h1>
      <FilterBar total={periodTxs.length} shown={txs.length} />
      {!data.categories.length && (
        <div className="banner warn">
          <span className="grow">Du har ingen kategorier endnu. Indsæt et eksempeltræ (kan rettes bagefter) – eller opret dine egne undervejs med "+ Ny kategori…" i kategorivalget.</span>
          <button className="btn sm primary" onClick={() => update((d) => ({ ...d, categories: defaultCategories() }))}>Indsæt eksempeltræ</button>
        </div>
      )}
      {excluded > 0 && (
        <div className="banner warn">
          <span className="grow">{excluded} transaktioner i {period.name} ligger før bogføringsstart ({data.settings.bookStart}) og tæller derfor ikke med.</span>
          <button className="btn sm primary" onClick={() => update((d) => ({ ...d, settings: { ...d.settings, bookStart: addDays(period.start, -1), bookStartSet: true } }))}>
            Flyt bogføringsstart til {addDays(period.start, -1)}
          </button>
        </div>
      )}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chrono'} className={tab === 'chrono' ? 'on' : ''} onClick={() => setTab('chrono')}>Gennemgang ({scopeReview} tilbage)</button>
        <button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>Grupperet</button>
        <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>Alle transaktioner ({txs.length})</button>
      </div>
      {!periodTxs.length && data.txs.length > 0 ? (
        <EmptyPeriod />
      ) : tab === 'chrono' ? <ChronoReview key={`${period.id}|${filter.accountId ?? 'alle'}`} txs={txs} scope={scope} searching={nActive > (filter.accountId ? 1 : 0)} /> : tab === 'review' ? <ReviewGroups txs={review} /> : <TxTable txs={txs} />}
    </div>
  );
}

/** Filtre og sortering – altid synlige øverst, så man kan søge lidt og hurtigt komme tilbage. */
function FilterBar({ total, shown }: { total: number; shown: number }) {
  const f = useStore((s) => s.ledgerFilter);
  const set = useStore((s) => s.setLedgerFilter);
  const reset = useStore((s) => s.resetLedgerFilter);
  const [more, setMore] = useState(() => !!(f.from || f.to || f.min || f.max || f.withNote));
  const ref = useRef<HTMLDivElement>(null);
  const n = activeFilterCount(f);
  // Gennemgangens statuslinje skal klæbe under filterlinjen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--filter-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.setProperty('--filter-h', '0px'); };
  }, []);
  const seg = <K extends 'type' | 'status'>(key: K, opts: [LedgerFilter[K], string][]) => (
    <div className="seg" role="radiogroup">
      {opts.map(([v, l]) => <button key={v} className={f[key] === v ? 'on plain' : ''} role="radio" aria-checked={f[key] === v} onClick={() => set({ [key]: v } as Partial<LedgerFilter>)}>{l}</button>)}
    </div>
  );
  return (
    <div className="filter-bar" ref={ref}>
      <LinkPickBanner />
      <div className="row">
        <div className="search-wrap grow">
          <input className="search-input" placeholder="Søg i tekst, noter, kommentarer, bankkategori eller beløb (fx 1.234,50)…" value={f.q}
            onChange={(ev) => set({ q: ev.target.value })} onKeyDown={(ev) => ev.key === 'Escape' && set({ q: '' })} aria-label="Søg" />
          {f.q && <button className="search-clear" onClick={() => set({ q: '' })} aria-label="Ryd søgning">✕</button>}
        </div>
        <AccountSelect className="sm" value={f.accountId} onChange={(accountId) => set({ accountId })} placeholder="Alle konti" filter={(a) => a.kind === 'bank'} />
        <CategoryCombo className="sm" value={f.categoryId} onChange={(categoryId) => set({ categoryId })} allowClear="Alle kategorier" ariaLabel="Filtrér på kategori" />
        <select className="sm" value={f.sort} onChange={(ev) => set({ sort: ev.target.value as LedgerFilter['sort'] })} aria-label="Sortér">
          <option value="date-asc">Dato, ældst først</option>
          <option value="date-desc">Dato, nyest først</option>
          <option value="amount-desc">Beløb, største først</option>
          <option value="amount-asc">Beløb, mindste først</option>
        </select>
      </div>
      <div className="row small">
        {seg('type', [['all', 'Alle typer'], ['income', 'Indtægt'], ['expense', 'Udgift'], ['internal', 'Intern']])}
        {seg('status', [['all', 'Alle'], ['pending', 'Mangler afgørelse'], ['done', 'Afgjort']])}
        <button className={`btn sm ghost ${more ? 'on' : ''}`} onClick={() => setMore(!more)}>{more ? 'Færre filtre ▴' : 'Dato, beløb, kommentar ▾'}</button>
        <span className="spacer" />
        <span className="muted">Viser {shown} af {total}</span>
        {n > 0 && <button className="btn sm ghost" onClick={reset}>Nulstil filtre ({n})</button>}
      </div>
      {more && (
        <div className="row small">
          <label className="row" style={{ gap: 4 }}>Fra <input type="date" className="sm" value={f.from ?? ''} onChange={(ev) => set({ from: ev.target.value || undefined })} /></label>
          <label className="row" style={{ gap: 4 }}>Til <input type="date" className="sm" value={f.to ?? ''} onChange={(ev) => set({ to: ev.target.value || undefined })} /></label>
          <label className="row" style={{ gap: 4 }}>Beløb fra <input className="sm num" style={{ width: 100 }} inputMode="decimal" placeholder="0" value={f.min ?? ''} onChange={(ev) => set({ min: ev.target.value })} /></label>
          <label className="row" style={{ gap: 4 }}>til <input className="sm num" style={{ width: 100 }} inputMode="decimal" placeholder="∞" value={f.max ?? ''} onChange={(ev) => set({ max: ev.target.value })} /> kr</label>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.withNote} onChange={(ev) => set({ withNote: ev.target.checked })} /> Kun med kommentar/note</label>
        </div>
      )}
    </div>
  );
}

function EmptyPeriod() {
  const e = useEngine();
  const period = usePeriod()!;
  const setPeriod = useStore((s) => s.setPeriod);
  const dates = e.data.txs.map((t) => t.date).sort();
  const withData = e.data.periods.filter((p) => e.data.txs.some((t) => inPeriod(t, p) && t.date > e.data.settings.bookStart));
  return (
    <div className="card msg">
      <h2>{period.name} indeholder ingen transaktioner</h2>
      <p className="ink2" style={{ margin: '8px 0 12px' }}>
        Dine importerede data går fra <b>{dates[0]}</b> til <b>{dates[dates.length - 1]}</b>. Vælg en periode, der dækker dem – eller importér data for {period.name}.
      </p>
      <div className="row">
        {withData.map((p) => <button key={p.id} className="btn primary" onClick={() => setPeriod(p.id)}>Skift til {p.name}</button>)}

      </div>
    </div>
  );
}

// ------------------------------------------------------------- Grupperet gennemsyn

function ReviewGroups({ txs }: { txs: Tx[] }) {
  const e = useEngine();
  const rulesOn = e.data.settings.rulesEnabled === true;
  const groups = useMemo(() => {
    const m = new Map<string, Tx[]>();
    for (const t of txs) {
      const k = `${normalizeText(t.text) || t.text}|${t.amount > 0 ? 'in' : 'out'}`;
      (m.get(k) ?? m.set(k, []).get(k)!).push(t);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || Math.abs(sumAmt(b[1])) - Math.abs(sumAmt(a[1])));
  }, [txs]);

  if (!txs.length) return <Empty>Intet at gennemse – alt er afgjort. 🎉</Empty>;
  const acceptable = groups.filter(([, g]) => {
    const r = e.resolved.get(g[0].id)!;
    return (r.source === 'bankmap' || r.source === 'bankguess') && isComplete(r.lines[0]);
  });
  return (
    <div className="card">
      <div className="card-head">
        <div className="grow">
          <p className="ink2">{txs.length} transaktioner i {groups.length} grupper.</p>
          <InfoBox>
            Forslagene kommer fra bankens kategorier (kan slås fra under Indstillinger → Regler).
            Vælg type og kategori for en hel gruppe ad gangen{rulesOn ? <> – med <b>Husk</b> klares samme tekst automatisk fremover</> : ''}.
          </InfoBox>
        </div>
        {acceptable.length > 0 && (
          <button className="btn" title="Godkender bankens forslag som dine valg (uden at lave regler)" onClick={() => {
            for (const [, g] of acceptable) setManual(g.map((t) => t.id), clsOf(e.resolved.get(g[0].id)!));
          }}>Godkend {acceptable.length} bankforslag</button>
        )}
      </div>
      {groups.map(([k, g]) => <GroupRow key={k} txs={g} />)}
    </div>
  );
}

const sumAmt = (g: Tx[]) => g.reduce((s, t) => s + t.amount, 0);

function GroupRow({ txs }: { txs: Tx[] }) {
  const e = useEngine();
  const accounts = e.data.accounts;
  const r = e.resolved.get(txs[0].id)!;
  const [cls, setCls] = useState<Classification>(clsOf(r));
  // Ingen regel som standard – man vælger det selv.
  const [remember, setRemember] = useState(false);
  const [open, setOpen] = useState(false);
  const total = sumAmt(txs);
  const ready = isComplete(cls);
  const rulesOn = e.data.settings.rulesEnabled === true;
  const apply = () => {
    const ids = txs.map((t) => t.id);
    if (rulesOn && remember) saveRule(txs[0], cls, ids);
    else setManual(ids, cls);
  };
  return (
    <div className="group">
      <div style={{ minWidth: 0 }}>
        <div className="ellipsis" title={txs[0].text}><b>{txs[0].text}</b></div>
        <div className="small muted row" style={{ gap: 6 }}>
          <SourceChip source={r.source} />
          {txs[0].bankCategory && <span className="ellipsis">Bank: {txs[0].bankCategory}{txs[0].bankSubcategory ? ` › ${txs[0].bankSubcategory}` : ''}</span>}
          <button className="btn sm ghost" onClick={() => setOpen(!open)}>{txs.length} stk {open ? '▴' : '▾'}</button>
        </div>
        {open && (
          <div className="small" style={{ marginTop: 6 }}>
            {txs.map((t) => (
              <div key={t.id} className="row" style={{ gap: 10 }}>
                <span className="muted">{dateShort(t.date)}</span>
                <span className="grow ellipsis">{t.text}</span>
                <span className="muted">{accounts.find((a) => a.id === t.accountId)?.name}</span>
                <Money v={t.amount} decimals />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="num"><Money v={total} decimals colored /></div>
      <ClassEditor value={cls} onChange={setCls} amount={total} accountId={txs[0].accountId} compact />
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        {rulesOn && <label className="row small ink2" title="Gem som regel, så samme tekst klassificeres automatisk fremover"><input type="checkbox" checked={remember} onChange={(ev) => setRemember(ev.target.checked)} /> Husk</label>}
        <button className="btn primary sm" disabled={!ready} onClick={apply}>Anvend</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Alle transaktioner


function TxTable({ txs }: { txs: Tx[] }) {
  const e = useEngine();
  const linkPick = useStore((st) => st.linkPick);
  const [limit, setLimit] = useState(150);
  const [splitTx, setSplitTx] = useState<string>();
  const accName = (id: string) => e.data.accounts.find((a) => a.id === id)?.name ?? id;
  if (!txs.length) return <Empty>Ingen transaktioner matcher.</Empty>;

  const onKey = (ev: React.KeyboardEvent<HTMLTableRowElement>, t: Tx, r: Resolved) => {
    if ((ev.target as HTMLElement).tagName !== 'TR') return;
    const row = ev.currentTarget;
    if (ev.key === 'ArrowDown' || ev.key === 'j') { (row.nextElementSibling as HTMLElement | null)?.focus(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp' || ev.key === 'k') { (row.previousElementSibling as HTMLElement | null)?.focus(); ev.preventDefault(); }
    else if (ev.key === 'Enter') { setManual([t.id], clsOf(r)); (row.nextElementSibling as HTMLElement | null)?.focus(); }
    else if (TYPE_KEYS[ev.key]) setManual([t.id], withTypeKey(clsOf(r), TYPE_KEYS[ev.key], t.amount, e.data.categories));
  };

  return (
    <div className="card">
      <InfoBox label="Tastatur">
        Tastatur: klik på en række og brug ↑/↓ (eller j/k), <b>1–2</b> for type (indtægt/udgift · intern), <b>Enter</b> godkender forslaget.
      </InfoBox>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Dato</th><th>Konto</th><th>Tekst</th><th className="num">Beløb</th><th style={{ minWidth: 430 }}>Klassifikation</th><th>Kilde</th><th /></tr>
          </thead>
          <tbody>
            {txs.slice(0, limit).flatMap((t) => {
              const r = e.resolved.get(t.id)!;
              const rows = [
                <tr key={t.id} data-ledgerrow={t.id} tabIndex={0} onKeyDown={(ev) => onKey(ev, t, r)} {...linkTargetProps(linkPick, t.id)}>
                  <td className="small">{dateShort(t.date)}</td>
                  <td className="small muted">{accName(t.accountId)}</td>
                  <td style={{ maxWidth: 320 }}>
                    <div className="ellipsis" title={t.text}>{t.text}</div>
                    <TxNotes tx={t} />
                    {t.bankCategory && <div className="small muted ellipsis">{t.bankCategory}{t.bankSubcategory ? ` › ${t.bankSubcategory}` : ''}</div>}
                  </td>
                  <td className="num"><Money v={t.amount} decimals colored /></td>
                  <td>
                    {r.lines.length > 1 ? (
                      <span className="small">{r.lines.length} dele{r.source === 'rule' ? ' (husket)' : ''}: {r.lines.map((l) => `${kr(Math.abs(l.amount))} ${l.type === 'outlay' ? `udlæg ${l.counterparty}` : l.type === 'internal' ? `→ ${internalTargetName(e.data.accounts, l) ?? 'intern'}` : categoryLabel(e.data.categories, l.categoryId) || l.type}`).join(' · ')}</span>
                    ) : (
                      <ClassEditor value={clsOf(r)} amount={t.amount} accountId={t.accountId} txId={t.id} compact onChange={(c) => setManual([t.id], c)} />
                    )}
                  </td>
                  <td>
                    <SourceChip source={r.source} />
                    {r.pairId && <div className="small muted" title="Parret intern overførsel">⇄ {accName(e.txById.get(r.pairId)!.accountId)}</div>}
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {e.data.settings.rulesEnabled === true && (r.source === 'manual' || NEEDS_REVIEW.has(r.source)) && (
                      <button className="btn sm ghost" title="Gem som regel for denne tekst" onClick={() => saveRule(t, clsOf(r), [t.id])}>Regel</button>
                    )}
                    {r.source === 'manual' && <button className="btn sm ghost" title="Fjern dit valg (brug regel/forslag)" onClick={() => { setManual([t.id], undefined); focusTxField(t.id, 'data-ledgerrow'); }}>↺</button>}
                    <button className="btn sm ghost" onClick={() => setSplitTx(t.id)}>{r.lines.length > 1 ? 'Ret opdeling' : 'Opdel'}</button>
                    {r.lines.length > 1 && <button className="btn sm ghost" title="Erstat opdelingen med én kategori" onClick={() => { setManual([t.id], clsOf(r)); focusTxField(t.id, 'data-ledgerrow'); }}>Én kategori</button>}
                  </td>
                </tr>,
              ];
              return rows;
            })}
          </tbody>
        </table>
      </div>
      {splitTx && e.txById.get(splitTx) && <SplitDialog tx={e.txById.get(splitTx)!} resolved={e.resolved.get(splitTx)!} onClose={() => setSplitTx(undefined)} />}
      {txs.length > limit && <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}><button className="btn" onClick={() => setLimit(limit + 300)}>Vis flere ({txs.length - limit} tilbage)</button></div>}
    </div>
  );
}

