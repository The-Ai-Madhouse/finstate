import { useEffect, useRef, useState, type ReactNode } from 'react';
import { dateShort } from '../../domain/format';
import { activeFilterCount, amountActive, type TxSort } from '../../domain/txfilter';
import { useStore, type LedgerFilter } from '../../store/store';
import { AccountSelect, CategoryCombo, LinkPickBanner, categoryLabel } from '../components/common';

/**
 * Filtre og sortering i Kategorisér – som overskrifterne i et regneark: hver kolonne viser, hvad den filtrerer på,
 * og kan sorteres (↑/↓/neutral) og filtreres. Klik på en kolonne for at justere den; "Alle filtre" folder dem alle ud.
 */

type Col = 'date' | 'text' | 'account' | 'category' | 'type' | 'status' | 'amount' | 'note';
type Dir = 'asc' | 'desc' | undefined;

const COLS: { id: Col; label: string }[] = [
  { id: 'date', label: 'Dato' },
  { id: 'text', label: 'Tekst' },
  { id: 'amount', label: 'Beløb' },
  { id: 'type', label: 'Type' },
  { id: 'category', label: 'Kategori' },
  { id: 'account', label: 'Konto' },
  { id: 'status', label: 'Status' },
  { id: 'note', label: 'Note' },
];

const TYPE_LABEL: Record<LedgerFilter['type'], string> = { all: 'Alle typer', income: 'Indtægt', expense: 'Udgift', internal: 'Intern' };
const STATUS_LABEL: Record<LedgerFilter['status'], string> = { all: 'Alle', pending: 'Mangler afgørelse', uncat: 'Uden kategori', done: 'Afgjort' };
const OP_LABEL = { gt: 'Større end', lt: 'Mindre end', eq: 'Lig med', between: 'Mellem' } as const;

/** Sorteringen for en kolonne: ↑, ↓ eller neutral. Dato ↑ (ældst først) er den neutrale rækkefølge for hele listen. */
function dirOf(col: Col, sort: TxSort): Dir {
  if (col === 'date') return sort === 'date-desc' ? 'desc' : sort === 'date-asc' ? 'asc' : undefined;
  if (col === 'amount') return sort === 'amount-asc' ? 'asc' : sort === 'amount-desc' ? 'desc' : undefined;
  if (col === 'text') return sort === 'text-asc' ? 'asc' : sort === 'text-desc' ? 'desc' : undefined;
  return undefined;
}
/** Næste sortering ved klik på pilen: dato ↑ ↔ ↓; beløb neutral → største → mindste; tekst neutral → A–Å → Å–A. */
function nextSort(col: Col, sort: TxSort): TxSort {
  const d = dirOf(col, sort);
  if (col === 'date') return d === 'asc' ? 'date-desc' : 'date-asc';
  if (col === 'amount') return !d ? 'amount-desc' : d === 'desc' ? 'amount-asc' : 'date-asc';
  return !d ? 'text-asc' : d === 'asc' ? 'text-desc' : 'date-asc';
}
const SORT_TEXT: Partial<Record<TxSort, string>> = {
  'date-asc': 'ældst først', 'date-desc': 'nyest først', 'amount-desc': 'største først', 'amount-asc': 'mindste først', 'text-asc': 'A–Å', 'text-desc': 'Å–A',
};
const sortable = (c: Col) => c === 'date' || c === 'amount' || c === 'text';

export function LedgerFilterBar({ total, shown }: { total: number; shown: number }) {
  const f = useStore((s) => s.ledgerFilter);
  const set = useStore((s) => s.setLedgerFilter);
  const reset = useStore((s) => s.resetLedgerFilter);
  const categories = useStore((s) => s.data.categories);
  const accounts = useStore((s) => s.data.accounts);
  const [all, setAll] = useState(() => { try { return localStorage.getItem('finstate:ui:filters-open') === '1'; } catch { return false; } });
  const toggleAll = () => setAll((x) => { try { localStorage.setItem('finstate:ui:filters-open', x ? '0' : '1'); } catch { /* ok */ } return !x; });
  const [open, setOpen] = useState<Col>();
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
  // Luk kolonnens vindue ved klik udenfor eller Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement;
      if (!t.closest(`[data-col="${open}"]`) && !t.closest('.combo-list')) setOpen(undefined);
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(undefined); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const amt = (s?: string) => (s?.trim() ? `${s.trim()} kr.` : '…');
  /** Det, kolonnen filtrerer på lige nu – vises under kolonnens navn. */
  const summary = (c: Col): { text: string; on: boolean } => {
    switch (c) {
      case 'date': return f.from || f.to
        ? { text: `${f.from ? dateShort(f.from) : '…'} – ${f.to ? dateShort(f.to) : '…'}`, on: true }
        : { text: 'Hele perioden', on: false };
      case 'text': return f.q.trim() ? { text: `"${f.q.trim()}"`, on: true } : { text: 'Alle', on: false };
      case 'amount': {
        if (!amountActive(f)) return { text: 'Alle beløb', on: false };
        if (f.amountOp === 'gt') return { text: `> ${amt(f.min)}`, on: true };
        if (f.amountOp === 'lt') return { text: `< ${amt(f.max)}`, on: true };
        if (f.amountOp === 'eq') return { text: `= ${amt(f.min)}`, on: true };
        return { text: `${f.min?.trim() || '0'} – ${f.max?.trim() || '∞'} kr.`, on: true };
      }
      case 'type': return { text: TYPE_LABEL[f.type], on: f.type !== 'all' };
      case 'category': return f.categoryId ? { text: categoryLabel(categories, f.categoryId), on: true } : { text: 'Alle', on: false };
      case 'account': return f.accountId ? { text: accounts.find((a) => a.id === f.accountId)?.name ?? '?', on: true } : { text: 'Alle konti', on: false };
      case 'status': return { text: STATUS_LABEL[f.status], on: f.status !== 'all' };
      case 'note': return f.withNote ? { text: 'Kun med note', on: true } : { text: 'Alle', on: false };
    }
  };
  const clear = (c: Col) => {
    const patch: Partial<LedgerFilter> =
      c === 'date' ? { from: undefined, to: undefined } : c === 'text' ? { q: '' } : c === 'amount' ? { min: '', max: '', amountOp: undefined }
      : c === 'type' ? { type: 'all' } : c === 'category' ? { categoryId: undefined } : c === 'account' ? { accountId: undefined }
      : c === 'status' ? { status: 'all' } : { withNote: false };
    set(patch);
  };

  const seg = <T extends string>(value: T, opts: [T, ReactNode][], onPick: (v: T) => void, label: string) => (
    <div className="seg colseg" role="radiogroup" aria-label={label}>
      {opts.map(([v, l]) => <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on plain' : ''} onClick={() => onPick(v)}>{l}</button>)}
    </div>
  );
  const sortSeg = (c: Col, opts: [TxSort | 'none', string][]) => {
    const d = dirOf(c, f.sort);
    const cur = (opts.find(([v]) => v !== 'none' && v === f.sort)?.[0] ?? 'none') as TxSort | 'none';
    return (
      <div className="colfield">
        <span className="colfield-label">Sortér {d ? '' : <span className="muted">(neutral)</span>}</span>
        {seg(cur, opts, (v) => set({ sort: v === 'none' ? 'date-asc' : v }), 'Sortering')}
      </div>
    );
  };

  /** Kolonnens indstillinger – bruges både i det lille vindue og i "Alle filtre". */
  const editor = (c: Col, autoFocus: boolean) => {
    switch (c) {
      case 'date': return (<>
        {sortSeg('date', [['date-asc', '↑ Ældst først'], ['date-desc', '↓ Nyest først']])}
        <div className="colfield">
          <span className="colfield-label">Periode</span>
          <div className="row" style={{ gap: 6 }}>
            <input type="date" className="sm" aria-label="Fra dato" value={f.from ?? ''} onChange={(ev) => set({ from: ev.target.value || undefined })} />
            <span className="muted">–</span>
            <input type="date" className="sm" aria-label="Til dato" value={f.to ?? ''} onChange={(ev) => set({ to: ev.target.value || undefined })} />
          </div>
        </div>
      </>);
      case 'text': return (<>
        <div className="colfield">
          <span className="colfield-label">Indeholder</span>
          <input className="sm" autoFocus={autoFocus} placeholder="Tekst, note, bankkategori eller beløb…" value={f.q} onChange={(ev) => set({ q: ev.target.value })} aria-label="Tekst indeholder" />
        </div>
        {sortSeg('text', [['none', 'Neutral'], ['text-asc', '↑ A–Å'], ['text-desc', '↓ Å–A']])}
      </>);
      case 'amount': {
        const op = f.amountOp ?? (f.min?.trim() && f.max?.trim() ? 'between' : f.min?.trim() ? 'gt' : f.max?.trim() ? 'lt' : undefined);
        const val = (key: 'min' | 'max', ph: string, focus?: boolean) => (
          <input className="sm num" style={{ width: 110 }} inputMode="decimal" placeholder={ph} autoFocus={focus} value={f[key] ?? ''}
            onChange={(ev) => set({ [key]: ev.target.value, amountOp: op } as Partial<LedgerFilter>)} aria-label={key === 'min' ? 'Beløb' : 'Til beløb'} />
        );
        return (<>
          <div className="colfield">
            <span className="colfield-label">Beløb <span className="muted">(uden fortegn – vælg retning under Type)</span></span>
            {seg((op ?? 'all') as 'all' | keyof typeof OP_LABEL, [['all', 'Alle'], ['gt', '>'], ['lt', '<'], ['eq', '='], ['between', 'Mellem']],
              (v) => {
                if (v === 'all') { set({ amountOp: undefined, min: '', max: '' }); return; }
                // Behold det tastede tal, når man skifter mellem > < =.
                const keep = f.min?.trim() || f.max?.trim() || '';
                set(v === 'lt' ? { amountOp: v, max: keep, min: '' } : v === 'between' ? { amountOp: v, min: f.min ?? keep, max: f.max ?? '' } : { amountOp: v, min: keep, max: '' });
              }, 'Sammenlign beløb')}
            {op && (
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <span className="muted small">{OP_LABEL[op]}</span>
                {op === 'lt' ? val('max', '0', autoFocus) : val('min', '0', autoFocus)}
                {op === 'between' && <><span className="muted">og</span>{val('max', '∞')}</>}
                <span className="muted small">kr.</span>
              </div>
            )}
          </div>
          {sortSeg('amount', [['none', 'Neutral'], ['amount-desc', '↓ Største først'], ['amount-asc', '↑ Mindste først']])}
        </>);
      }
      case 'type': return <div className="colfield">{seg(f.type, (Object.keys(TYPE_LABEL) as LedgerFilter['type'][]).map((k) => [k, TYPE_LABEL[k]]), (type) => set({ type }), 'Type')}</div>;
      case 'status': return <div className="colfield">{seg(f.status, (Object.keys(STATUS_LABEL) as LedgerFilter['status'][]).map((k) => [k, STATUS_LABEL[k]]), (status) => set({ status }), 'Status')}</div>;
      case 'category': return <div className="colfield"><CategoryCombo className="sm" value={f.categoryId} onChange={(categoryId) => set({ categoryId })} allowClear="Alle kategorier" ariaLabel="Filtrér på kategori" /></div>;
      case 'account': return <div className="colfield"><AccountSelect className="sm" value={f.accountId} onChange={(accountId) => set({ accountId })} placeholder="Alle konti" filter={(a) => a.kind === 'bank'} /></div>;
      case 'note': return <div className="colfield"><label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.withNote} onChange={(ev) => set({ withNote: ev.target.checked })} /> Kun med kommentar eller note</label></div>;
    }
  };

  const arrow = (c: Col) => {
    if (!sortable(c)) return null;
    const d = dirOf(c, f.sort);
    const label = COLS.find((x) => x.id === c)!.label;
    return (
      <button className={`colsort ${d ? 'on' : ''}`} onClick={() => set({ sort: nextSort(c, f.sort) })}
        title={`${label}: ${d ? SORT_TEXT[f.sort] : 'neutral'} – klik for at skifte`} aria-label={`Sortér efter ${label.toLowerCase()}`}>
        {d === 'asc' ? '↑' : d === 'desc' ? '↓' : '↕'}
      </button>
    );
  };

  return (
    <div className="filter-bar" ref={ref}>
      <LinkPickBanner />
      <div className="row">
        <div className="search-wrap grow">
          <input className="search-input" placeholder="Søg i tekst, noter, kommentarer, bankkategori eller beløb (fx 1.234,50)…" value={f.q}
            onChange={(ev) => set({ q: ev.target.value })} onKeyDown={(ev) => ev.key === 'Escape' && set({ q: '' })} aria-label="Søg" />
          {f.q && <button className="search-clear" onClick={() => set({ q: '' })} aria-label="Ryd søgning">✕</button>}
        </div>
        <span className="muted small">Viser {shown} af {total}</span>
        {n > 0 && <button className="btn sm ghost" onClick={reset}>Nulstil ({n})</button>}
        <button className={`btn sm ${all ? 'on' : ''}`} onClick={toggleAll} aria-expanded={all}>{all ? 'Skjul filtre ▴' : 'Alle filtre ▾'}</button>
      </div>

      {all ? (
        <div className="colgrid">
          {COLS.map((c) => {
            const s = summary(c.id);
            return (
              <div key={c.id} className={`colcard ${s.on || dirOf(c.id, f.sort) && f.sort !== 'date-asc' ? 'on' : ''}`}>
                <div className="colcard-head">
                  <b>{c.label}</b>{arrow(c.id)}<span className="grow" />
                  {s.on && <button className="linkish small" onClick={() => clear(c.id)}>Ryd</button>}
                </div>
                {editor(c.id, false)}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="colbar" role="toolbar" aria-label="Filtrér og sortér som i et regneark">
          {COLS.map((c, i) => {
            const s = summary(c.id);
            const d = dirOf(c.id, f.sort);
            const sorted = !!d && f.sort !== 'date-asc';
            return (
              <div key={c.id} data-col={c.id} className={`colcell ${s.on ? 'on' : ''} ${sorted ? 'sorted' : ''} ${open === c.id ? 'open' : ''}`}>
                <button className="colcell-main" onClick={() => setOpen(open === c.id ? undefined : c.id)} aria-expanded={open === c.id} title={`Filtrér på ${c.label.toLowerCase()}`}>
                  <span className="colcell-label">{c.label} <span className="caret-sm" aria-hidden>▾</span></span>
                  <span className="colcell-val">{s.text}{d && sortable(c.id) && f.sort !== 'date-asc' ? ` · ${SORT_TEXT[f.sort]}` : ''}</span>
                </button>
                {arrow(c.id)}
                {open === c.id && (
                  <div className={`popover colpop ${i >= COLS.length / 2 ? 'right' : ''}`} role="dialog" aria-label={`Filtrér på ${c.label.toLowerCase()}`}>
                    <div className="colcard-head"><b>{c.label}</b><span className="grow" />{s.on && <button className="linkish small" onClick={() => clear(c.id)}>Ryd</button>}</div>
                    {editor(c.id, true)}
                    <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}><button className="btn sm" onClick={() => setOpen(undefined)}>Færdig</button></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
