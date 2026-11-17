import { categoryPath, flattenTree } from '../../domain/categories';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NEEDS_REVIEW, SOURCE_LABEL, type Source } from '../../domain/classify';
import type { Check, Engine } from '../../domain/engine';
import { kr, kr2f, parseAmount } from '../../domain/format';
import { type Account, type Category, type Classification, type Period, type Tx, type TxType } from '../../domain/types';
import { newCategoryId } from '../../domain/defaults';
import { useData, useStore, type LinkPick, type View } from '../../store/store';
import { setMemo, useEngine, usePeriod } from '../../store/actions';
import { balancesAt, isTransitRef, transitName } from '../../domain/ledger';
import { linkedWith, unlinkTx } from '../../domain/links';
import { postMovements, transferInfo } from '../../domain/transfers';
import { isSettled, settleState } from '../../domain/settle';
import { dateShort } from '../../domain/format';
import { KIND_LABEL, NO_TYPE, addAccountType, noteFor, suggestCategory, withAccountInPeriods } from '../../domain/accountTypes';
import { addDays, uid } from '../../domain/util';

/**
 * Beløb. decimals: "1.234,56" (tabeller med transaktioner). precise: "1.234,56 kr" (saldi i balancen).
 * Ellers hele kroner: "1.235 kr".
 */
/** colored: + grøn, − rød. inverted: omvendt (fx passiver, hvor mere gæld er dårligt). */
export function Money({ v, decimals, precise, signed, colored, inverted }: { v: number; decimals?: boolean; precise?: boolean; signed?: boolean; colored?: boolean; inverted?: boolean }) {
  const txt = precise ? `${kr2f(signed ? Math.abs(v) : v)} kr` : decimals ? kr2f(signed ? Math.abs(v) : v) : kr(signed ? Math.abs(v) : v);
  // Fortegn og farve ud fra det viste (afrundede) beløb – ellers "−0 kr".
  const shown = decimals || precise ? v : Math.round(v / 100) * 100;
  const sign = signed ? (shown > 0 ? '+' : shown < 0 ? '−' : '') : '';
  const good = inverted ? shown < 0 : shown > 0;
  return <span className={`num ${colored && shown ? (good ? 'pos' : 'neg') : ''}`}>{sign}{txt}</span>;
}

/** Indtægt og udgift er ét valg – hvilken det er, følger af beløbets fortegn (og kategorien). */
export type TypeKey = 'pl' | 'internal';
export const TYPE_KEYS: Record<string, TypeKey> = { '1': 'pl', '2': 'internal' };
export const typeKeyOf = (t?: TxType): TypeKey | undefined => (t === 'income' || t === 'expense' ? 'pl' : t === 'internal' || t === 'outlay' ? 'internal' : undefined);
export const plLabel = (amount: number) => (amount > 0 ? 'Indtægt' : amount < 0 ? 'Udgift' : 'Indtægt/udgift');

/** Indtægt eller udgift for en kategori – en "begge"-kategori følger beløbets fortegn. */
export const plTypeOf = (cat: Category | undefined, amount: number): 'income' | 'expense' =>
  !cat || cat.kind === 'both' ? (amount > 0 ? 'income' : 'expense') : cat.kind;

/** Skift type ud fra en tast/knap – bevarer kategori/modpart, hvor det giver mening. */
export function withTypeKey(c: Classification, key: TypeKey, amount: number, categories: Category[]): Classification {
  if (key === 'pl') {
    const cat = categories.find((x) => x.id === c.categoryId);
    return { type: plTypeOf(cat, amount), categoryId: cat?.id };
  }
  return { type: 'internal', targetAccountId: c.targetAccountId };
}

export function TypeSeg({ value, amount, onChange }: { value?: TxType; amount: number; onChange: (k: TypeKey) => void }) {
  const cur = typeKeyOf(value);
  const opts: { k: TypeKey; label: string; t: string; tip: string }[] = [
    { k: 'pl', label: plLabel(amount), t: amount > 0 ? 'income' : 'expense', tip: 'Rigtige penge ind eller ud – følger beløbets fortegn' },
    { k: 'internal', label: 'Intern', t: 'internal', tip: 'Penge der flytter til/fra en post på din balance – en anden konto, et depot, et lån eller fx "Jonas skylder mig". Hverken indtægt eller udgift.' },
  ];
  return (
    <div className="seg" role="radiogroup" aria-label="Type">
      {opts.map((o, i) => (
        <button key={o.k} data-t={o.t} className={cur === o.k ? 'on' : ''} role="radio" aria-checked={cur === o.k} title={`${o.tip} (tast ${i + 1})`} onClick={() => onChange(o.k)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Opret kategori/underkategori på stedet – uden at forlade det, man er i gang med. */
export const KIND_NAME: Record<Category['kind'], string> = { income: 'Indtægt', expense: 'Udgift', both: 'Begge veje' };

function NewCategoryForm({ kind: fixedKind, defaultKind, defaultParent, onDone, initialName = '' }: {
  kind?: Category['kind'];
  defaultKind?: Category['kind'];
  defaultParent?: string;
  onDone: (id?: string) => void;
  initialName?: string;
}) {
  const { categories } = useData();
  const update = useStore((s) => s.update);
  const [kind, setKind] = useState<Category['kind']>(fixedKind ?? categories.find((c) => c.id === defaultParent)?.kind ?? defaultKind ?? 'expense');
  const tops = flattenTree(categories, categories.filter((c) => !c.parentId && c.kind === kind));
  const [parent, setParent] = useState<string>(defaultParent && tops.some((t) => t.cat.id === defaultParent) ? defaultParent : '');
  const [name, setName] = useState(initialName);
  const dup = categories.some((c) => c.kind === kind && (c.parentId ?? '') === parent && c.name.trim().toLowerCase() === name.trim().toLowerCase());
  const create = () => {
    if (!name.trim() || dup) return;
    const id = newCategoryId(categories, kind, name.trim(), parent || undefined);
    update((d) => ({ ...d, categories: [...d.categories, { id, name: name.trim(), kind, parentId: parent || undefined }] }));
    onDone(id);
  };
  return (
    <div
      className="row newcat newpost"
      // Enter/Escape må ikke boble op til fx gennemgangens "gem og gå videre".
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); create(); }
        if (e.key === 'Escape') { e.stopPropagation(); onDone(); }
      }}
    >
      <span className="small ink2">Ny kategori:</span>
      <input className="sm grow" autoFocus placeholder={parent ? 'Navn på underkategori' : 'Navn på kategori'} value={name} onChange={(e) => setName(e.target.value)} aria-label="Navn på kategori"
        style={dup ? { borderColor: 'var(--critical)' } : undefined} title={dup ? 'Findes allerede' : undefined} />
      {!fixedKind && (
        <select className="sm" value={kind} onChange={(e) => { setKind(e.target.value as Category['kind']); setParent(''); }} aria-label="Indtægt eller udgift"
          title="Begge veje: fx renter eller afkast – positivt beløb er indtægt, negativt er udgift">
          <option value="expense">Udgift</option>
          <option value="income">Indtægt</option>
          <option value="both">Begge veje (fx renter)</option>
        </select>
      )}
      <select className="sm" value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Placering">
        <option value="">Ny hovedkategori</option>
        {tops.map(({ cat }) => <option key={cat.id} value={cat.id}>Under {categoryPath(categories, cat.id)}</option>)}
      </select>
      <button className="btn sm primary" disabled={!name.trim() || dup} onClick={create}>Opret</button>
      <button className="btn sm ghost" onClick={() => onDone()} aria-label="Annullér">✕</button>
    </div>
  );
}

const fold = (s: string) => s.toLowerCase().replace(/å/g, 'aa').replace(/æ/g, 'ae').replace(/ø/g, 'oe').normalize('NFD').replace(/[̀-ͯ]/g, '');

export type ComboOption = { id: string; label: string; group?: string; sub?: boolean; depth?: number; hint?: string };

/**
 * Søgbar dropdown – samme adfærd overalt: åbner ved fokus, skriv for at filtrere, ↑/↓ for at flytte,
 * Enter for at vælge (og evt. gemme/gå videre via onCommit). Valgfrit: en "ingen"-mulighed øverst og "+ Opret …" nederst.
 */
export function SearchCombo({ options, value, onChange, onCommit, onTypeKey, onCreate, createLabel, allowClear, placeholder = '— vælg —', searchPlaceholder = 'Søg…', ariaLabel, className, inputRef: extRef, emptyText = 'Intet matcher', needsChoice, initialQuery, onQueryChange }: {
  options: ComboOption[];
  value?: string;
  onChange: (id: string | undefined) => void;
  onCommit?: (id: string) => void;
  /** Skift type i kategoriseringen: 1/2 i et tomt felt, Alt+1/Alt+2 altid. Får søgeteksten med. */
  onTypeKey?: (key: string, q: string) => void;
  /** Søgetekst, feltet starter med ved første fokus (fx med over fra et typeskift). */
  initialQuery?: string;
  onQueryChange?: (q: string) => void;
  /** "+ Opret …" nederst – får søgeteksten med. */
  onCreate?: (q: string) => void;
  createLabel?: (q: string) => string;
  /** Vis en "ingen"-mulighed øverst med denne tekst. */
  allowClear?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  ariaLabel: string;
  className?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  emptyText?: string;
  /** Markér feltet som "skal udfyldes", når intet er valgt. */
  needsChoice?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = extRef ?? ownRef;
  const initialUsed = useRef(false);
  useEffect(() => { onQueryChange?.(q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  type Opt = ComboOption & { isNew?: boolean; isClear?: boolean };
  const words = fold(q).split(/\s+/).filter(Boolean);
  const filtered = words.length ? options.filter((o) => words.every((w) => fold(`${o.group ?? ''} ${o.label}`).includes(w))) : options;
  const opts: Opt[] = [
    ...(allowClear && !words.length ? [{ id: '__clear__', label: allowClear, isClear: true }] : []),
    ...filtered,
    ...(onCreate ? [{ id: '__new__', label: createLabel ? createLabel(q.trim()) : q.trim() ? `+ Opret "${q.trim()}"…` : '+ Opret ny…', isNew: true }] : []),
  ];
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const choose = (o: Opt, commit: boolean) => {
    setOpen(false);
    setQ('');
    if (o.isNew) { onCreate?.(q.trim()); return; }
    if (o.isClear) { onChange(undefined); return; }
    onChange(o.id);
    if (commit) onCommit?.(o.id);
  };

  return (
    <div className={`combo ${className ?? ''}`}>
      <input
        ref={inputRef}
        className={`combo-input ${needsChoice && !value ? 'needs-choice' : ''}`}
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        placeholder={open ? searchPlaceholder : allowClear ?? placeholder}
        value={open ? q : current?.label ?? ''}
        onFocus={() => {
          setOpen(true);
          if (initialQuery && !initialUsed.current) { initialUsed.current = true; setQ(initialQuery); setHi(0); return; }
          setQ(''); setHi(Math.max(0, opts.findIndex((o) => o.id === value || (o.isClear && !value))));
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => { setQ(e.target.value); setHi(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); e.preventDefault(); return; }
          if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setHi((h) => Math.min(opts.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const o = open ? opts[hi] : current;
            if (o) choose(o, true);
            else if (value) onCommit?.(value);
          } else if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); setQ(''); } }
          else if (onTypeKey && e.altKey && /^Digit[12]$/.test(e.code)) { e.preventDefault(); e.stopPropagation(); onTypeKey(e.code.slice(5), q); }
          // 1/2 skifter type – også med tekst i feltet, så længe teksten ikke er et tal (fx et beløb).
          else if (onTypeKey && !e.altKey && /^[12]$/.test(e.key) && !/\d/.test(q)) { e.preventDefault(); e.stopPropagation(); onTypeKey(e.key, q); }
        }}
      />
      {open && (
        <div className="combo-list" role="listbox" ref={listRef}>
          {opts.map((o, i) => (
            <Fragment key={o.id}>
              {o.group && (i === 0 || opts[i - 1].group !== o.group) && <div className="combo-group">{o.group}</div>}
              <div
                data-i={i}
                role="option"
                aria-selected={i === hi}
                className={`combo-opt ${i === hi ? 'hi' : ''} ${o.id === value || (o.isClear && !value) ? 'cur' : ''} ${o.isNew ? 'new' : ''} ${o.isClear ? 'clear' : ''} ${o.sub ? 'sub' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); choose(o, false); }}
                onMouseEnter={() => setHi(i)}
                style={o.depth && o.depth > 1 ? { paddingLeft: 16 + (o.depth - 1) * 14 } : undefined}
              >
                <span>{o.label}{o.hint && <span className="combo-hint"> {o.hint}</span>}</span>{(o.id === value || (o.isClear && !value)) && <span className="combo-check">✓</span>}
              </div>
            </Fragment>
          ))}
          {!filtered.length && words.length > 0 && <div className="combo-empty">{emptyText} "{q}"</div>}
        </div>
      )}
    </div>
  );
}

/** Søgbart kategorivalg (bygger på SearchCombo) – med "+ Ny kategori…" på stedet. */
export function CategoryCombo({ value, onChange, onCommit, onTypeKey, primaryKind, className, allowClear, placeholder = '— vælg kategori —', ariaLabel = 'Kategori', initialQuery, onQueryChange }: {
  value?: string;
  onChange: (id: string | undefined) => void;
  onCommit?: (id: string) => void;
  onTypeKey?: (key: string, q: string) => void;
  initialQuery?: string;
  onQueryChange?: (q: string) => void;
  primaryKind?: 'income' | 'expense';
  className?: string;
  /** Vis en "ingen"-mulighed øverst (fx "Ukategoriseret"). */
  allowClear?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const { categories } = useData();
  const [creating, setCreating] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const options: ComboOption[] = useMemo(() => {
    const kinds: Category['kind'][] = primaryKind === 'income' ? ['income', 'both', 'expense'] : ['expense', 'both', 'income'];
    const out: ComboOption[] = [];
    for (const k of kinds) {
      const group = k === 'both' ? 'Begge veje' : primaryKind && k !== primaryKind ? (k === 'expense' ? 'Refusion af udgift' : 'Tilbagebetaling af indtægt') : k === 'income' ? 'Indtægter' : 'Udgifter';
      for (const { cat, depth } of flattenTree(categories, categories.filter((c) => !c.parentId && c.kind === k))) {
        out.push({ id: cat.id, label: depth ? categoryPath(categories, cat.id) : cat.name, group, sub: depth > 0, depth });
      }
    }
    return out;
  }, [categories, primaryKind]);

  if (creating !== null) {
    const cur = categories.find((c) => c.id === value);
    return (
      <NewCategoryForm defaultKind={primaryKind} initialName={creating} defaultParent={cur ? cur.parentId ?? cur.id : undefined}
        onDone={(id) => { setCreating(null); if (id) onChange(id); setTimeout(() => inputRef.current?.focus(), 0); }} />
    );
  }
  return (
    <SearchCombo className={className} options={options} value={value} onChange={onChange} onCommit={onCommit} onTypeKey={onTypeKey}
      initialQuery={initialQuery} onQueryChange={onQueryChange} allowClear={allowClear} placeholder={placeholder} searchPlaceholder="Søg kategori…" ariaLabel={ariaLabel} inputRef={inputRef}
      emptyText="Ingen kategori matcher"
      onCreate={(q) => setCreating(q)} createLabel={(q) => (q ? `+ Opret "${q}" som ny kategori…` : '+ Ny kategori…')} />
  );
}

export function categoryLabel(categories: Category[], id?: string): string {
  if (!id) return '';
  const c = categories.find((x) => x.id === id);
  if (!c) return `(${id})`;
  return categoryPath(categories, c.id);
}

export function AccountSelect({ value, onChange, exclude, filter, placeholder = '— vælg konto —', className }: {
  value?: string;
  onChange: (id: string | undefined) => void;
  exclude?: string;
  filter?: (a: Account) => boolean;
  placeholder?: string;
  className?: string;
}) {
  const { accounts } = useData();
  const options = accounts.filter((a) => a.id !== exclude && (!a.archived || a.id === value) && (!filter || filter(a))).map((a) => ({ id: a.id, label: a.name }));
  return <SearchCombo className={className} options={options} value={value} onChange={onChange} allowClear={placeholder} searchPlaceholder="Søg konto…" ariaLabel="Konto" emptyText="Ingen konto matcher" />;
}

/** Type + det der hører til typen (kategori, modpart eller post) – og en sætning om, hvad der sker. */
export function ClassEditor({ value, onChange, accountId, amount, compact, txId, onCommit }: {
  value: Classification;
  onChange: (c: Classification) => void;
  accountId?: string;
  amount: number;
  compact?: boolean;
  /** Transaktionen der redigeres – så dens egne posteringer ikke tæller med i personens saldo. */
  txId?: string;
  /** Enter i kategorisøgningen: vælg OG gem/gå videre (bruges i gennemgangen). */
  onCommit?: (c: Classification) => void;
}) {
  const sm = compact ? 'sm' : '';
  const { categories } = useData();
  const signKind = amount > 0 ? 'income' : amount < 0 ? 'expense' : undefined;
  const isPl = value.type === 'income' || value.type === 'expense';
  const wrapRef = useRef<HTMLDivElement>(null);
  // Søgeteksten følger med, når man skifter type (fx "jonas" skrevet i kategorifeltet → videre til postfeltet).
  const lastQ = useRef('');
  const [carry, setCarry] = useState<{ n: number; q: string }>({ n: 0, q: '' });
  // Efter typeskift: markøren direkte i søgefeltet (kategori eller post), så man kan skrive videre.
  const focusSearch = () => setTimeout(() => wrapRef.current?.querySelector<HTMLInputElement>('.combo-input')?.focus(), 0);
  const switchType = (k: TypeKey, q = lastQ.current) => {
    setCarry((c) => ({ n: c.n + 1, q }));
    onChange(withTypeKey(value, k, amount, categories));
    focusSearch();
  };
  const onQ = (q: string) => { lastQ.current = q; };
  return (
    <div className="col class-editor-wrap" style={{ gap: 4 }} ref={wrapRef}>
      <div className="row class-editor">
        <TypeSeg value={value.type} amount={amount} onChange={(k) => switchType(k)} />
        {isPl && (
          <CategoryCombo key={`c${carry.n}`} className={`grow ${sm}`} primaryKind={signKind} value={value.categoryId}
            initialQuery={carry.q} onQueryChange={onQ}
            onChange={(categoryId) => onChange({ type: plTypeOf(categories.find((c) => c.id === categoryId), amount), categoryId })}
            onCommit={onCommit && ((categoryId) => onCommit({ type: plTypeOf(categories.find((c) => c.id === categoryId), amount), categoryId }))}
            onTypeKey={(key, q) => switchType(TYPE_KEYS[key], q)} />
        )}
        {value.type === 'internal' && (
          <TargetSelect key={`t${carry.n}`} txId={txId} initialQuery={carry.q} onQueryChange={onQ} className={`grow ${sm}`} exclude={accountId} amount={amount} value={value.transitRef ?? value.targetAccountId} onChange={(id) => onChange(internalTo(id))}
            onCommit={onCommit && ((id) => onCommit(internalTo(id)))}
            onTypeKey={(key, q) => switchType(TYPE_KEYS[key], q)} />
        )}
      </div>
      <ClassHint value={value} amount={amount} txId={txId} />
    </div>
  );
}

/**
 * Brugerens egne posttyper + "Ingen type" + "+ Ny type…" (oprettes på stedet).
 */
export function TypeSelect({ value, onChange, className }: { value?: string; onChange: (id: string | undefined) => void; className?: string }) {
  const { accountTypes } = useData();
  const update = useStore((s) => s.update);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const create = (n: string) => {
    if (!n.trim()) return;
    let id = '';
    update((d) => { const r = addAccountType(d, n); id = r.id; return r.data; });
    onChange(id);
    setCreating(false);
    setName('');
  };
  if (creating) {
    return (
      <span className="row" style={{ flexWrap: 'nowrap', gap: 4 }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); create(name); } if (e.key === 'Escape') { e.stopPropagation(); setCreating(false); } }}>
        <input className={`sm ${className ?? ''}`} autoFocus placeholder="Ny type, fx Opsparing" value={name} onChange={(e) => setName(e.target.value)} aria-label="Navn på ny type" />
        <button className="btn sm primary" disabled={!name.trim()} onClick={() => create(name)}>Opret</button>
        <button className="btn sm ghost" onClick={() => setCreating(false)} aria-label="Annullér">✕</button>
      </span>
    );
  }
  return (
    <SearchCombo className={`${className ?? ''} combo-narrow`} options={accountTypes.map((t) => ({ id: t.id, label: t.name }))} value={value} onChange={onChange}
      allowClear={NO_TYPE} searchPlaceholder="Søg eller skriv ny type…" ariaLabel="Type" emptyText="Ingen type matcher"
      // Har man skrevet et navn, oprettes typen med det samme.
      onCreate={(q) => (q ? create(q) : setCreating(true))} createLabel={(q) => (q ? `+ Opret typen "${q}"` : '+ Ny type…')} />
  );
}

/** Hvordan postens saldo findes: følger overførsler eller tastes selv. */
export function KindSelect({ value, onChange, className }: { value: 'tracked' | 'valuation'; onChange: (k: 'tracked' | 'valuation') => void; className?: string }) {
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value as 'tracked' | 'valuation')} aria-label="Saldo">
      <option value="tracked">{KIND_LABEL.tracked}</option>
      <option value="valuation">{KIND_LABEL.valuation}</option>
    </select>
  );
}

/** Post på balancen (alle poster i én søgbar liste) – med mulighed for at oprette en ny post på stedet. */
function TargetSelect({ value, onChange, onCommit, onTypeKey, exclude, className, amount, initialQuery, onQueryChange, txId }: {
  value?: string;
  /** Transaktionen, der vælges for – dens egne posteringer tæller ikke med i "tilbage". */
  txId?: string;
  onChange: (id?: string) => void;
  onCommit?: (id: string) => void;
  onTypeKey?: (key: string, q: string) => void;
  initialQuery?: string;
  onQueryChange?: (q: string) => void;
  exclude?: string;
  className?: string;
  amount: number;
}) {
  const { accounts, accountTypes, categories } = useData();
  const update = useStore((s) => s.update);
  const periodId = useStore((s) => s.periodId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState<string | undefined>();
  const [kind, setKind] = useState<'tracked' | 'valuation'>('tracked');
  const inputRef = useRef<HTMLInputElement>(null);
  const e = useEngine();
  const period = usePeriod();
  // Det, der stod undervejs ved periodens start, minus det, periodens andre transaktioner allerede har hentet.
  const transitAtStart = useMemo(() => {
    if (!period) return [];
    const date = addDays(period.start, -1);
    return [...balancesAt(e.ledger, date).entries()]
      .filter(([ref, v]) => isTransitRef(ref) && v !== 0)
      .map(([ref, primo]) => {
        const used = e.ledger.postings.filter((p) => p.ref === ref && p.date >= period.start && p.date <= period.end && p.txId !== txId).reduce((s, p) => s + p.amount, 0);
        return { ref, amount: primo + used, date };
      });
  }, [e, period, txId]);
  if (creating) {
    const create = () => {
      if (!name.trim()) return;
      const id = uid('acc');
      // Penge ud til posten → den er typisk noget, du har (aktiv); penge ind → noget, du skylder.
      const side = amount < 0 ? 'asset' : 'liability';
      update((d) => withAccountInPeriods({ ...d, accounts: [...d.accounts, { id, name: name.trim(), kind, typeId, side, aliases: [], defaultCategoryId: kind === 'valuation' ? suggestCategory(categories, side) : undefined }] }, id, periodId));
      onChange(id);
      setCreating(false);
      setName('');
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    return (
      <div className="row newcat newpost" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).getAttribute('role') !== 'combobox') { e.preventDefault(); e.stopPropagation(); create(); } if (e.key === 'Escape') { e.stopPropagation(); setCreating(false); } }}>
        <span className="small ink2">Ny post:</span>
        <input className="sm grow" autoFocus placeholder={amount < 0 ? 'Fx Jonas skylder mig' : 'Fx Jeg skylder Ida'} value={name} onChange={(e) => setName(e.target.value)} aria-label="Navn på post" />
        <TypeSelect className="sm" value={typeId} onChange={setTypeId} />
        <KindSelect className="sm" value={kind} onChange={setKind} />
        <button className="btn sm primary" disabled={!name.trim()} onClick={create}>Opret</button>
        <button className="btn sm ghost" onClick={() => setCreating(false)} aria-label="Annullér">✕</button>
      </div>
    );
  }
  const typeOf = (a: Account) => accountTypes.find((t) => t.id === a.typeId)?.name;
  // Penge undervejs fra forrige periode (samme retning som beløbet) – fx en overførsel, der blev sendt før nytår og først lander nu.
  const transitOpts: ComboOption[] = transitAtStart
    .filter((x) => x.ref === value || (x.amount !== 0 && Math.sign(x.amount) === Math.sign(amount)))
    .map((x) => ({ id: x.ref, label: `${transitName({ accounts }, x.ref)} – fra forrige periode`, hint: `· ${kr(Math.abs(x.amount))} tilbage`, group: 'Penge undervejs fra forrige periode' }));
  const options: ComboOption[] = [
    ...transitOpts,
    ...accounts
      .filter((a) => a.id !== exclude && (!a.archived || a.id === value))
      .map((a) => ({ id: a.id, label: a.name, hint: typeOf(a) ? `· ${typeOf(a)}` : undefined, group: transitOpts.length ? 'Poster' : undefined })),
  ];
  return (
    <SearchCombo className={className} options={options} value={value} onChange={onChange} onCommit={onCommit} onTypeKey={onTypeKey} inputRef={inputRef}
      initialQuery={initialQuery} onQueryChange={onQueryChange}
      placeholder={`— hvor ${amount < 0 ? 'skal pengene hen' : 'kommer pengene fra'}? —`} searchPlaceholder="Søg post…" ariaLabel="Til/fra" needsChoice
      emptyText="Ingen post matcher"
      onCreate={(q) => { setName(q); setCreating(true); }} createLabel={(q) => (q ? `+ Opret "${q}" som ny post…` : '+ Ny post…')} />
  );
}

/** Intern overførsel til/fra en post – eller fra penge undervejs ("transit…"). */
const internalTo = (id?: string): Classification =>
  id && isTransitRef(id) ? { type: 'internal', transitRef: id } : { type: 'internal', targetAccountId: id };

/** Navnet på det, en intern linje flytter til/fra: posten – eller penge undervejs. */
export function internalTargetName(accounts: Account[], l: Pick<Classification, 'targetAccountId' | 'transitRef'>): string | undefined {
  if (l.transitRef) return transitName({ accounts }, l.transitRef);
  return accounts.find((a) => a.id === l.targetAccountId)?.name;
}

/** Én sætning om, hvad valget betyder for regnskabet – især for udlæg/gæld. */
function ClassHint({ value, amount }: { value: Classification; amount: number; txId?: string }) {
  const { categories, accounts } = useData();
  if (value.type === 'internal' && value.transitRef) {
    return <div className="class-hint">Pengene {amount < 0 ? 'går til' : 'kommer fra'} <b>{transitName({ accounts }, value.transitRef).replace(/^Undervejs/, 'penge undervejs')}</b> fra forrige periode – beløbet trækkes fra det, der stod undervejs. Hverken indtægt eller udgift.</div>;
  }
  if (value.type === 'internal' || value.type === 'outlay') {
    const t = accounts.find((a) => a.id === value.targetAccountId);
    const dir = amount < 0 ? 'til' : 'fra';
    if (!t) return <div className="class-hint">Vælg den post på din balance, pengene flytter {dir} – eller opret en ny.</div>;
    return <div className="class-hint">Pengene flytter {dir} <b>{t.name}</b>. Hverken indtægt eller udgift.</div>;
  }
  const cat = categories.find((c) => c.id === value.categoryId);
  if (cat?.kind === 'both') return <div className="class-hint"><b>{cat.name}</b> går begge veje – her en {amount >= 0 ? 'indtægt' : 'udgift'}.</div>;
  if (cat && amount !== 0 && (cat.kind === 'expense') !== amount < 0) {
    return <div className="class-hint">{amount > 0 ? <>Refusion – <b>trækkes fra udgiften</b> {cat.name}.</> : <>Tilbagebetaling – <b>trækkes fra indtægten</b> {cat.name}.</>}</div>;
  }
  return null;
}

export function SourceChip({ source }: { source: Source }) {
  const cls = NEEDS_REVIEW.has(source) ? 'review' : source === 'manual' || source === 'rule' || source === 'split' ? 'user' : '';
  return <span className={`chip ${cls}`}>{SOURCE_LABEL[source]}</span>;
}

const ICON: Record<Check['level'], string> = { ok: '✓', info: 'i', warn: '!', error: '×' };
const LEVEL_TXT: Record<Check['level'], string> = { ok: 'OK', info: 'Info', warn: 'Advarsel', error: 'Fejl' };

export function CheckList({ checks }: { checks: Check[] }) {
  const goTo = useStore((s) => s.goTo);
  return (
    <div>
      {checks.map((c) => (
        <div key={c.id} className="check">
          <span className={`ico ${c.level}`} aria-label={LEVEL_TXT[c.level]}>{ICON[c.level]}</span>
          <div className="grow">
            <div>{c.title}</div>
            {c.detail && <div className="small muted">{c.detail}</div>}
          </div>
          {c.view && c.level !== 'ok' && (
            <button className="btn sm" title="Gå til stedet, hvor det kan rettes – det bliver fremhævet" onClick={() => goTo(c.target ?? { view: c.view as View })}>Gå til →</button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Formatér et beløb mens man skriver: tusindtalsseparator, komma som decimal, max 2 decimaler. */
export function formatAmountLive(raw: string): string {
  const neg = /^\s*[-−]/.test(raw);
  const cleaned = raw.replace(/[^\d,]/g, '');
  const [intRaw, ...rest] = cleaned.split(',');
  const intPart = intRaw.replace(/^0+(?=\d)/, '');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const hasComma = cleaned.includes(',');
  const dec = rest.join('').slice(0, 2);
  return `${neg ? '−' : ''}${grouped || (hasComma ? '0' : '')}${hasComma ? ',' + dec : ''}`;
}
/** Antal "betydende" tegn (cifre, komma, minus) – bruges til at holde markøren på plads. */
const sigCount = (s: string) => (s.match(/[\d,−-]/g) ?? []).length;

/**
 * Beløbsfelt: tusindtalsseparator mens man skriver og "kr" i slutningen.
 * Gemmer ved Enter eller når feltet forlades.
 */
export function AmountInput({ value, onCommit, onLive, className, placeholder, ariaLabel, autoFocus }: {
  value?: number;
  onCommit: (v: number | undefined) => void;
  /** Kaldes for hvert tastetryk med det foreløbige beløb (fx så "resten" i en opdeling følger med). */
  onLive?: (v: number | undefined) => void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const fmt = (v?: number) => (v === undefined ? '' : kr2f(v).replace('-', '−'));
  const [txt, setTxt] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const shown = focused ? txt : fmt(value);
  const bad = txt.trim() !== '' && parseAmount(txt) === null;
  return (
    <span className={`amount-wrap ${shown ? 'has-value' : ''}`}>
      <input
        ref={ref}
        className={`num ${className ?? ''}`}
        style={bad ? { borderColor: 'var(--critical)' } : undefined}
        value={shown}
        inputMode="decimal"
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        onFocus={(e) => { setTxt(fmt(value)); setFocused(true); const el = e.currentTarget; setTimeout(() => el.select(), 0); }}
        onChange={(e) => {
          const el = e.target;
          const caret = el.selectionStart ?? el.value.length;
          const before = sigCount(el.value.slice(0, caret));
          const next = formatAmountLive(el.value);
          setTxt(next);
          if (onLive) {
            const v = next.trim() === '' ? undefined : parseAmount(next.replace('−', '-'));
            if (v !== null) onLive(v);
          }
          // Sæt markøren efter samme antal betydende tegn som før formateringen.
          requestAnimationFrame(() => {
            if (!ref.current) return;
            let pos = 0, n = 0;
            while (pos < next.length && n < before) { if (/[\d,−-]/.test(next[pos])) n++; pos++; }
            ref.current.setSelectionRange(pos, pos);
          });
        }}
        onBlur={() => {
          setFocused(false);
          if (txt.trim() === '') onCommit(undefined);
          else { const v = parseAmount(txt.replace('−', '-')); if (v !== null) onCommit(v); }
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="amount-suffix" aria-hidden>kr</span>
    </span>
  );
}

/** Forklaring/eksempler – sammenklappet som standard, så siden ikke fyldes med tekst. */
export function InfoBox({ children, label = 'Sådan virker det' }: { children: ReactNode; label?: string }) {
  return (
    <details className="infobox">
      <summary><span className="infobox-i" aria-hidden>i</span>{label}</summary>
      <div className="infobox-body">{children}</div>
    </details>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>{children}</div>;
}

export function Tile({ label, value, delta, deltaGood }: { label: string; value: ReactNode; delta?: ReactNode; deltaGood?: boolean }) {
  return (
    <div className="tile">
      <div className="lbl">{label}</div>
      <div className="val num" style={{ textAlign: 'left' }}>{value}</div>
      {delta !== undefined && <div className={`delta ${deltaGood === undefined ? 'muted' : deltaGood ? 'pos' : 'neg'}`}>{delta}</div>}
    </div>
  );
}

/**
 * Bankens kommentar (importeret, kan ikke rettes) og din egen note (kan rettes) – vist forskelligt,
 * så det altid er tydeligt, hvem der har skrevet hvad.
 */
export function TxNotes({ tx }: { tx: Tx }) {
  const [editing, setEditing] = useState(false);
  const [txt, setTxt] = useState(tx.memo ?? '');
  const save = () => { setMemo(tx.id, txt); setEditing(false); };
  return (
    <div className="tx-notes">
      {tx.note && <div className="bank-note" title="Kommentar fra din netbank (importeret)">❝ {tx.note} <span className="src">fra banken</span></div>}
      {editing ? (
        <input
          className="sm memo-input"
          autoFocus
          value={txt}
          placeholder="Din note – fx hvem var med, hvad det var til"
          onChange={(ev) => setTxt(ev.target.value)}
          onBlur={save}
          onKeyDown={(ev) => {
            ev.stopPropagation(); // Enter må ikke gemme/gå videre i gennemgangen
            if (ev.key === 'Enter') save();
            if (ev.key === 'Escape') { setTxt(tx.memo ?? ''); setEditing(false); }
          }}
          aria-label="Din note"
        />
      ) : tx.memo ? (
        <button className="memo" title="Din note – klik for at rette" onClick={() => { setTxt(tx.memo ?? ''); setEditing(true); }}>✎ {tx.memo}</button>
      ) : null}
      <TxLinks tx={tx} addNote={!editing && !tx.memo ? () => { setTxt(''); setEditing(true); } : undefined} />
    </div>
  );
}

/** Hvad "vælg en anden transaktion" skal gøre for denne transaktion – eller intet (fx parrede overførsler). */
function pickModeFor(e: Engine, tx: Tx, period?: Period): Omit<LinkPick, 'txId'> | undefined {
  const info = period ? transferInfo(e.data, e.resolved, e.txById, tx, period) : undefined;
  if (!info) return { mode: 'plain' };
  if (info.kind === 'missing') return { mode: 'bank' };
  if (info.kind === 'direct' && info.target?.kind === 'tracked' && period) {
    const inGroup = settleState(e.data, e.ledger, info.target.id, period).groups.some((g) => g.items.some((i) => i.key === `tx:${tx.id}`));
    return inGroup ? undefined : { mode: 'post', postId: info.target.id, periodId: period.id };
  }
  return undefined; // parret, undervejs eller direkte til en post, du taster selv – intet at vælge her
}

/** Kan transaktionen vælges som den anden i et par? (Bank: en anden konto og modsat retning.) */
function validPick(pick: LinkPick, other: Tx, txs: Tx[]): boolean {
  if (other.id === pick.txId) return false;
  const src = txs.find((t) => t.id === pick.txId);
  if (!src) return false;
  if (pick.mode === 'bank') return other.accountId !== src.accountId && Math.sign(other.amount) === -Math.sign(src.amount);
  if (pick.mode === 'post') return other.accountId !== pick.postId;
  return !src.link || other.link !== src.link;
}

/** Den anden er valgt: vis parringen, så man kan se om det går op – og skrive, hvor en evt. rest skal hen. */
function completePick(pick: LinkPick, otherId: string) {
  const { setLinkPick, setPairDraft } = useStore.getState();
  setLinkPick(undefined);
  setPairDraft({ pick, otherId });
}

/**
 * Under transaktionens tekst: det, den er parret med – og "⇄ Par…" til at vælge en anden transaktion.
 * Knappen er synlig på overførsler, der mangler at blive parret (på en post eller med modposten); på almindelige transaktioner ved hover.
 */
function TxLinks({ tx, addNote }: { tx: Tx; addNote?: () => void }) {
  const e = useEngine();
  const txs = e.data.txs;
  const accounts = e.data.accounts;
  const update = useStore((s) => s.update);
  const showTx = useStore((s) => s.showTx);
  const period = usePeriod();
  // Kun én ad gangen: valget står i store – så man også kan klikke på den anden i listen.
  const pick = useStore((s) => (s.linkPick?.txId === tx.id ? s.linkPick : undefined));
  const setLinkPick = useStore((s) => s.setLinkPick);
  const others = linkedWith(txs, tx);
  const sum = others.reduce((s, t) => s + t.amount, tx.amount);
  // Resten hører hjemme i den kategori, de parrede står i (samme for alle i gruppen).
  const cats = new Set([tx, ...others].map((t) => e.resolved.get(t.id)?.lines.find((l) => l.categoryId)?.categoryId ?? ''));
  const restCat = cats.size === 1 ? [...cats][0] || undefined : undefined;
  // Parret som intern (fx på et lån) – så er der ingen "rest" at placere.
  const allInternal = [tx, ...others].every((t) => e.resolved.get(t.id)?.lines.every((l) => l.type === 'internal'));
  const showTransfers = useStore((s) => s.showTransfers);
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';
  const mode = pickModeFor(e, tx, period);
  // Søgefeltet åbner ikke af sig selv – dets liste ville ellers ligge hen over rækkerne, man skal kunne klikke på.
  const start = () => { if (mode) setLinkPick({ txId: tx.id, ...mode }); };
  const inPeriod = (t: Tx) => !period || (t.date >= period.start && t.date <= period.end);
  const options = pick
    ? txs
      .filter((t) => inPeriod(t) && validPick(pick, t, txs))
      // Samme beløb (modsat retning) først, så nærmeste dato.
      .sort((a, b) => Number(b.amount === -tx.amount) - Number(a.amount === -tx.amount) || Math.abs(Date.parse(a.date) - Date.parse(tx.date)) - Math.abs(Date.parse(b.date) - Date.parse(tx.date)))
      .slice(0, 400)
      .map((t) => ({ id: t.id, label: `${dateShort(t.date)} · ${t.text} · ${kr2f(t.amount)}`, hint: `· ${accName(t.accountId)}${pick.mode === 'post' && !isInternalTo(e, t, pick.postId!) ? ' · flyttes til posten' : ''}` }))
    : [];
  const postName = pick?.postId ? accName(pick.postId) : mode?.postId ? accName(mode.postId) : '';
  const btnLabel = mode?.mode === 'bank' ? '⇄ Find modpost…' : others.length ? '⇄ Par med flere…' : '⇄ Par…';
  const btnTitle = mode?.mode === 'post' ? `Par med det, den hører sammen med på ${postName} – fx tilbagebetalingen. Står den anden som noget andet, flyttes den til ${postName}.`
    : mode?.mode === 'bank' ? 'Find den anden side af overførslen – den sættes til intern overførsel mellem de to konti'
    : 'Par med en anden transaktion (fx et udlæg og indbetalingen). Går de ikke op, vælger du, hvor resten hører hjemme.';
  return (
    <>
      <TxRelations tx={tx} />
      {others.length > 0 && (
        <div className="tx-links" onKeyDown={(ev) => ev.stopPropagation()}>
          <span className="tx-links-label" title="Parret af dig – begge står i samme kategori, så kun resten tæller">⇄ Parret med</span>
          {others.map((o) => (
            <span key={o.id} className="tx-link">
              <button className="linkish" title="Vis transaktionen" onClick={() => showTx(o.id)}>{dateShort(o.date)} {o.text}</button>
              <span className="num small">{kr2f(o.amount)}</span>
              {others.length > 1 && <button className="tx-link-x" title="Tag ud af gruppen" aria-label={`Tag ${o.text} ud af gruppen`} onClick={() => update((d) => unlinkTx(d, o.id))}>✕</button>}
            </span>
          ))}
          <span className="small muted">i alt <span className={sum === 0 ? 'pos' : ''}>{kr2f(sum)}{sum === 0 ? ' ✓' : ''}</span></span>
          {sum !== 0 && (restCat
            ? <span className="small">resten → <b>{categoryLabel(e.data.categories, restCat)}</b></span>
            : !allInternal && <button className="tx-link-x" title="Vælg, hvor resten hører hjemme – under Afstemning" onClick={() => showTransfers({ settle: true, groupId: tx.link })}>Placér resten →</button>)}
          <button className="tx-link-x" title="Ophæv parringen for denne transaktion (kategorien bevares)" aria-label="Ophæv parring" onClick={() => update((d) => unlinkTx(d, tx.id))}>Ophæv</button>
        </div>
      )}
      {pick ? (
        <span className="tx-link-add" onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Escape') setLinkPick(undefined); }}>
          <SearchCombo className="sm" options={options} value={undefined}
            placeholder={pick.mode === 'post' ? `Par med… (${postName})` : pick.mode === 'bank' ? 'Modposten…' : 'Par med…'}
            searchPlaceholder="Søg dato, tekst eller beløb…" ariaLabel="Vælg den anden transaktion" emptyText="Ingen transaktion matcher – eller klik på den i listen"
            onChange={(id) => { if (id) completePick(pick, id); }} />
          <button className="btn sm ghost" onClick={() => setLinkPick(undefined)} aria-label="Annullér">✕</button>
          <span className="small muted">eller klik på den i listen</span>
        </span>
      ) : (
        <span className="row" style={{ gap: 10 }}>
          {addNote && <button className="add-memo" onClick={addNote}>+ Note</button>}
          {/* Overførsler, der skal parres, får en synlig knap; almindelige transaktioner viser den ved hover (som "+ Note"). */}
          {mode && <button className={`add-memo ${mode.mode !== 'plain' ? 'pair-btn' : ''}`} title={btnTitle} onClick={start}>{btnLabel}</button>}
        </span>
      )}
    </>
  );
}

/** Er transaktionen allerede "Intern → posten"? */
function isInternalTo(e: Engine, t: Tx, postId: string) {
  return !!e.resolved.get(t.id)?.lines.some((l) => l.type === 'internal' && l.targetAccountId === postId);
}

/**
 * Det, der hører sammen af sig selv: den parrede modpost – eller, for en direkte overførsel til en post
 * (fx "Jonas skylder mig" eller et billån), periodens andre bevægelser på samme post. Klik for at hoppe.
 */
function TxRelations({ tx }: { tx: Tx }) {
  const e = useEngine();
  const period = usePeriod();
  const [open, setOpen] = useState(false);
  if (!period) return null;
  const info = transferInfo(e.data, e.resolved, e.txById, tx, period);
  if (!info) return null;
  const { showTx, showPost, showTransfers } = useStore.getState();
  const accName = (id: string) => e.data.accounts.find((a) => a.id === id)?.name ?? '';
  const txBtn = (t: Tx) => (
    <button className="linkish" title="Vis transaktionen" onClick={() => showTx(t.id)}>{dateShort(t.date)} {accName(t.accountId)} "{t.text}"</button>
  );
  if (info.partner) {
    return (
      <div className="tx-rel" onKeyDown={(ev) => ev.stopPropagation()}>
        <span className="tx-rel-label" title="Den anden side af den interne overførsel">⇄ Parret med</span>
        {txBtn(info.partner)} <span className="num small">{kr2f(info.partner.amount)}</span>
        {info.kind === 'transit' && <span className="chip" title="Modposten ligger i en anden periode – pengene er undervejs">anden periode</span>}
        <button className="tx-link-x" title="Se overførslen på Overførsler-siden" onClick={() => showTransfers({ txId: tx.id })}>Overførsler →</button>
      </div>
    );
  }
  if (info.kind === 'missing') {
    return (
      <div className="tx-rel warn" onKeyDown={(ev) => ev.stopPropagation()}>
        <span className="tx-rel-label">⇄ Mangler modpost</span>
        <button className="tx-link-x" title="Find modposten på Overførsler-siden" onClick={() => showTransfers({ txId: tx.id })}>Find den i Overførsler →</button>
      </div>
    );
  }
  if (info.kind !== 'direct' || !info.target) return null;
  const target = info.target;
  const others = postMovements(e.data, e.resolved, target.id, period).filter((t) => t.id !== tx.id);
  const sum = others.reduce((s, t) => s + t.amount, tx.amount);
  // Poster, der følger overførsler (fx en person): er bevægelsen parret med det, den hører sammen med – og går det op?
  // Kun poster, du har valgt at afstemme.
  const st = target.kind === 'tracked' && isSettled(period, target) ? settleState(e.data, e.ledger, target.id, period) : undefined;
  const group = st?.groups.find((g) => g.items.some((i) => i.key === `tx:${tx.id}`));
  const mates = group?.items.filter((i) => i.key !== `tx:${tx.id}`) ?? [];
  const pairing = st && (
    <div className="tx-rel-pair">
      {group ? (
        <>
          <span className={`chip ${group.sum === 0 ? 'user' : 'review'}`}>{group.sum === 0 ? '✓ Parret – går op' : `Parret – ${group.sum > 0 ? `mangler ${kr(group.sum)}` : `${kr(-group.sum)} for meget`}`}</span>
          <span className="small muted">med</span>
          {mates.map((m) => (m.txId
            ? <button key={m.key} className="linkish" onClick={() => showTx(m.txId!)}>{dateShort(m.date)} "{m.text}" {kr2f(m.amount)}</button>
            : <span key={m.key} className="small">{m.primo ? 'saldo primo' : m.text} {kr2f(m.amount)}</span>))}
        </>
      ) : <span className="chip review" title="Par den med det, den hører sammen med – fx udlægget og tilbagebetalingen">Ikke parret</span>}
      <button className="tx-link-x" title="Par bevægelserne på posten – og afskriv en evt. difference" onClick={() => showTransfers({ settle: true, postId: target.id, txId: tx.id })}>{group ? 'Ret i Afstemning →' : 'Par i Afstemning →'}</button>
    </div>
  );
  return (
    <div className="tx-rel" onKeyDown={(ev) => ev.stopPropagation()}>
      <span className="tx-rel-label" title="Direkte overførsel til en post – alle bevægelser på posten hører sammen">◆ Via posten</span>
      <button className="linkish" title="Se posten og bevægelsen i Aktiver & passiver" onClick={() => showPost(target.id, `move:${tx.id}`)}>{target.name}</button>
      {others.length > 0
        ? <button className="tx-link-x" aria-expanded={open} onClick={() => setOpen(!open)}>{others.length} {others.length === 1 ? 'anden' : 'andre'} i {period.name} {open ? '▴' : '▾'}</button>
        : <span className="small muted">ingen andre i {period.name}</span>}
      {open && (
        <div className="tx-rel-list">
          {others.map((t) => <span key={t.id} className="tx-link">{txBtn(t)} <span className="num small">{kr2f(t.amount)}</span></span>)}
          <span className="small muted">i alt med denne: {kr2f(sum)}</span>
        </div>
      )}
      {pairing}
    </div>
  );
}

/** Er klassifikationen komplet? Intern kræver en valgt post; indtægt/udgift kræver en kategori. */
export const isComplete = (c: Classification) => (c.type === 'internal' ? !!(c.targetAccountId || c.transitRef) : c.type === 'outlay' || !!c.categoryId);

/** Kommentar på en aktiv/passiv – vises under navnet, rettes ved klik, "+ Kommentar" ved hover. */
export function AccountNote({ account }: { account: Account }) {
  const update = useStore((s) => s.update);
  const periodId = useStore((s) => s.periodId);
  const note = noteFor(account, periodId);
  const [editing, setEditing] = useState(false);
  const [txt, setTxt] = useState(note ?? '');
  const save = () => {
    const v = txt.trim();
    if (periodId) update((d) => ({ ...d, accounts: d.accounts.map((a) => {
      if (a.id !== account.id) return a;
      const notes = { ...a.notes };
      if (v) notes[periodId] = v; else delete notes[periodId];
      return { ...a, notes };
    }) }));
    setEditing(false);
  };
  if (editing) {
    return (
      <input className="sm memo-input" autoFocus value={txt} placeholder="Kommentar til posten" aria-label={`Kommentar til ${account.name}`}
        onChange={(e) => setTxt(e.target.value)} onBlur={save}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') { setTxt(note ?? ''); setEditing(false); } }} />
    );
  }
  // Uden kommentar: en diskret knap på samme linje som navnet (fylder ingen ekstra højde).
  if (!note) {
    return <span className="tx-notes inline"><button className="add-memo" onClick={(e) => { e.stopPropagation(); setTxt(''); setEditing(true); }}>+ Kommentar</button></span>;
  }
  return (
    <div className="tx-notes">
      <button className="memo" title="Kommentar – klik for at rette" onClick={(e) => { e.stopPropagation(); setTxt(note ?? ''); setEditing(true); }}>✎ {note}</button>
    </div>
  );
}

/** "heraf afkast 700 kr" – hvad en værdipost har bidraget med i resultatet i perioden. */
export function ResultParts({ parts, categories }: { parts: Map<string, number>; categories: Category[] }) {
  const items = [...parts.entries()].filter(([, v]) => Math.round(v / 100) !== 0);
  if (!items.length) return null;
  return (
    <div className="result-part">
      {items.map(([ref, v]) => {
        const name = ref.startsWith('cat:') ? categoryLabel(categories, ref.slice(4)) : 'ukategoriseret';
        return <div key={ref}>heraf {name} {kr(Math.abs(v))}</div>;
      })}
    </div>
  );
}

/**
 * Mens man vælger, hvad en transaktion skal parres med: rækkerne i listen kan klikkes for at vælge den anden.
 * Bruges på både gennemgangens rækker og den grupperede tabel.
 */
export function linkTargetProps(pick: LinkPick | undefined, txId: string) {
  if (!pick || pick.txId === txId) return { className: pick?.txId === txId ? 'link-source' : '' };
  const txs = useStore.getState().data.txs;
  const other = txs.find((t) => t.id === txId);
  if (!other || !validPick(pick, other, txs)) return { className: 'link-disabled' };
  return {
    className: 'link-target',
    title: 'Klik for at parre med den valgte transaktion',
    onClickCapture: (ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      completePick(pick, txId);
    },
  };
}

/** Banner øverst, mens man vælger: hvilken transaktion man knytter fra – og Esc/Annullér. */
export function LinkPickBanner() {
  const pick = useStore((s) => s.linkPick);
  const tx = useStore((s) => s.data.txs.find((t) => t.id === s.linkPick?.txId));
  const postName = useStore((s) => s.data.accounts.find((a) => a.id === s.linkPick?.postId)?.name);
  const setLinkPick = useStore((s) => s.setLinkPick);
  useEffect(() => {
    if (!pick) return;
    // I "capture"-fasen, så Esc også annullerer, når markøren står i søgefeltet (som ellers selv fanger Esc).
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setLinkPick(undefined); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pick, setLinkPick]);
  if (!pick || !tx) return null;
  return (
    <div className="banner info link-banner">
      <span className="grow">{pick.mode === 'post'
        ? <>⇄ Klik på det, <b>{dateShort(tx.date)} "{tx.text}"</b> ({kr2f(tx.amount)}) skal parres med på <b>{postName}</b> – står den som noget andet, flyttes den til {postName}.</>
        : pick.mode === 'bank'
          ? <>⇄ Klik på modposten til <b>{dateShort(tx.date)} "{tx.text}"</b> ({kr2f(tx.amount)}) – på en anden af dine konti.</>
          : <>⇄ Klik på den transaktion, <b>{dateShort(tx.date)} "{tx.text}"</b> ({kr2f(tx.amount)}) skal parres med – eller søg den frem i søgefeltet.</>}</span>
      <span className="spacer" />
      <button className="btn sm" onClick={() => setLinkPick(undefined)}>Annullér (Esc)</button>
    </div>
  );
}
