/** Filtrering og sortering af transaktioner i Kategorisér. */
import { descendants } from './categories';
import { NEEDS_REVIEW, type Resolved } from './classify';
import { kr2f, parseAmount } from './format';
import type { Category, Tx } from './types';

export interface TxFilter {
  q: string;
  accountId?: string;
  categoryId?: string;
  type: 'all' | 'income' | 'expense' | 'internal';
  /** uncat: indtægt/udgift uden kategori. */
  status: 'all' | 'pending' | 'done' | 'uncat';
  from?: string;
  to?: string;
  min?: string;
  max?: string;
  /**
   * Hvordan beløbet sammenlignes (altid uden fortegn – retningen vælges med typen):
   * gt = større end min · lt = mindre end max · eq = lig med min · between = fra min til max. Uden: min/max som grænser.
   */
  amountOp?: 'gt' | 'lt' | 'eq' | 'between';
  /** Kun penge ind (positive beløb) eller ud (negative beløb) – uanset hvordan de er kategoriseret. */
  amountSign?: 'in' | 'out';
  withNote: boolean;
  sort: TxSort;
  /** Flervalg (som i et regneark). Tomme/uden = den enkelte værdi ovenfor (bruges, når andre sider linker hertil). */
  accountIds?: string[];
  categoryIds?: string[];
  types?: TxType[];
  statuses?: TxStatus[];
}

export type TxType = Exclude<TxFilter['type'], 'all'>;
export type TxStatus = Exclude<TxFilter['status'], 'all'>;

/** De valgte værdier for en kolonne – flervalget, eller den enkelte værdi. Tom = alle. */
export const accountsOf = (f: TxFilter): string[] => (f.accountIds?.length ? f.accountIds : f.accountId ? [f.accountId] : []);
export const categoriesOf = (f: TxFilter): string[] => (f.categoryIds?.length ? f.categoryIds : f.categoryId ? [f.categoryId] : []);
export const typesOf = (f: TxFilter): TxType[] => (f.types?.length ? f.types : f.type !== 'all' ? [f.type] : []);
export const statusesOf = (f: TxFilter): TxStatus[] => (f.statuses?.length ? f.statuses : f.status !== 'all' ? [f.status] : []);

/** date-asc er den neutrale rækkefølge (som i banken). */
export type TxSort = 'date-asc' | 'date-desc' | 'amount-desc' | 'amount-asc' | 'signed-asc' | 'signed-desc' | 'text-asc' | 'text-desc';

/** Matcher søgeteksten beløbet? Dansk ("1.234,5" / "1234,50") og engelsk ("1234.5") skrivemåde. */
export function amountMatches(amount: number, q: string): boolean {
  const raw = q.replace(/\s/g, '');
  if (!/^[−-]?[\d.,]+$/.test(raw) || !/\d/.test(raw)) return false;
  const neg = /^[−-]/.test(raw);
  if (neg && amount >= 0) return false;
  const qa = raw.replace(/^[−-]/, '');
  const abs = Math.abs(amount);
  const plain = (abs / 100).toFixed(2); // "1234.50"
  const forms = [plain.replace('.', ','), kr2f(abs), plain];
  return forms.some((f) => f.includes(qa));
}

/** Fritekst: transaktionens tekst, bankens kategori, din note, bankens kommentar – eller beløbet. */
export function textMatches(t: Tx, q: string): boolean {
  const nq = q.trim().toLowerCase();
  if (!nq) return true;
  if (amountMatches(t.amount, nq)) return true;
  const words = nq.split(/\s+/);
  const hay = [t.text, t.bankCategory, t.bankSubcategory, t.memo, t.note].filter(Boolean).join(' \u0001 ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Har transaktionen en indtægts-/udgiftslinje uden kategori? */
export const hasUncategorized = (r: Resolved) => r.lines.some((l) => (l.type === 'income' || l.type === 'expense') && !l.categoryId);

export function filterTxs(txs: Tx[], resolved: Map<string, Resolved>, categories: Category[], f: TxFilter): Tx[] {
  const cats = categoriesOf(f), accs = new Set(accountsOf(f)), types = typesOf(f), statuses = statusesOf(f);
  const inCategory = new Set(cats.flatMap((c) => descendants(categories, c)));
  const statusOk = (r: Resolved, s: TxStatus) =>
    s === 'pending' ? NEEDS_REVIEW.has(r.source) : s === 'done' ? !NEEDS_REVIEW.has(r.source) : hasUncategorized(r);
  const typeOk = (r: Resolved, ty: TxType) => r.lines.some((l) => (ty === 'internal' ? l.type === 'internal' || l.type === 'outlay' : l.type === ty));
  const min = f.min?.trim() ? parseAmount(f.min) : null;
  const max = f.max?.trim() ? parseAmount(f.max) : null;
  const out = txs.filter((t) => {
    const r = resolved.get(t.id);
    if (!r) return false;
    if (accs.size && !accs.has(t.accountId)) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (f.amountSign === 'in' && t.amount <= 0) return false;
    if (f.amountSign === 'out' && t.amount >= 0) return false;
    const abs = Math.abs(t.amount);
    if (f.amountOp === 'gt') { if (min !== null && abs <= Math.abs(min)) return false; }
    else if (f.amountOp === 'lt') { if (max !== null && abs >= Math.abs(max)) return false; }
    else if (f.amountOp === 'eq') { if (min !== null && abs !== Math.abs(min)) return false; }
    else {
      if (min !== null && abs < Math.abs(min)) return false;
      if (max !== null && abs > Math.abs(max)) return false;
    }
    if (f.withNote && !t.note && !t.memo) return false;
    if (statuses.length && !statuses.some((s) => statusOk(r, s))) return false;
    if (types.length && !types.some((ty) => typeOk(r, ty))) return false;
    if (cats.length && !r.lines.some((l) => l.categoryId && inCategory.has(l.categoryId))) return false;
    return textMatches(t, f.q);
  });
  return sortTxs(out, f.sort);
}

export function sortTxs(txs: Tx[], sort: TxFilter['sort']): Tx[] {
  const byDate = (a: Tx, b: Tx) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq);
  const s = [...txs];
  if (sort === 'date-asc') s.sort(byDate);
  else if (sort === 'date-desc') s.sort((a, b) => byDate(b, a));
  else if (sort === 'amount-desc') s.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || byDate(a, b));
  else if (sort === 'amount-asc') s.sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount) || byDate(a, b));
  // Med fortegn: største udgift først (−→+) eller største indtægt først (+→−).
  else if (sort === 'signed-asc') s.sort((a, b) => a.amount - b.amount || byDate(a, b));
  else if (sort === 'signed-desc') s.sort((a, b) => b.amount - a.amount || byDate(a, b));
  else {
    const coll = new Intl.Collator('da', { sensitivity: 'base', numeric: true });
    const dir = sort === 'text-desc' ? -1 : 1;
    s.sort((a, b) => dir * coll.compare(a.text, b.text) || byDate(a, b));
  }
  return s;
}

/** Hvor mange filtre (ud over sortering) er slået til? */
export const activeFilterCount = (f: TxFilter) =>
  [f.q.trim(), accountsOf(f).length, categoriesOf(f).length, typesOf(f).length, statusesOf(f).length, f.from || f.to, amountActive(f), f.withNote].filter(Boolean).length;

/** Er der et beløbsfilter, der faktisk filtrerer? */
export function amountActive(f: TxFilter): boolean {
  const a = !!f.min?.trim(), b = !!f.max?.trim();
  if (f.amountSign) return true;
  return f.amountOp === 'gt' || f.amountOp === 'eq' ? a : f.amountOp === 'lt' ? b : a || b;
}
