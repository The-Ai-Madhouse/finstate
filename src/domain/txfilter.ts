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
  withNote: boolean;
  sort: TxSort;
}

/** date-asc er den neutrale rækkefølge (som i banken). */
export type TxSort = 'date-asc' | 'date-desc' | 'amount-desc' | 'amount-asc' | 'text-asc' | 'text-desc';

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
  const inCategory = new Set(f.categoryId ? descendants(categories, f.categoryId) : []);
  const min = f.min?.trim() ? parseAmount(f.min) : null;
  const max = f.max?.trim() ? parseAmount(f.max) : null;
  const out = txs.filter((t) => {
    const r = resolved.get(t.id);
    if (!r) return false;
    if (f.accountId && t.accountId !== f.accountId) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    const abs = Math.abs(t.amount);
    if (f.amountOp === 'gt') { if (min !== null && abs <= Math.abs(min)) return false; }
    else if (f.amountOp === 'lt') { if (max !== null && abs >= Math.abs(max)) return false; }
    else if (f.amountOp === 'eq') { if (min !== null && abs !== Math.abs(min)) return false; }
    else {
      if (min !== null && abs < Math.abs(min)) return false;
      if (max !== null && abs > Math.abs(max)) return false;
    }
    if (f.withNote && !t.note && !t.memo) return false;
    if (f.status === 'pending' && !NEEDS_REVIEW.has(r.source)) return false;
    if (f.status === 'done' && NEEDS_REVIEW.has(r.source)) return false;
    if (f.status === 'uncat' && !hasUncategorized(r)) return false;
    if (f.type !== 'all' && !r.lines.some((l) => (f.type === 'internal' ? l.type === 'internal' || l.type === 'outlay' : l.type === f.type))) return false;
    if (f.categoryId && !r.lines.some((l) => l.categoryId && inCategory.has(l.categoryId))) return false;
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
  else {
    const coll = new Intl.Collator('da', { sensitivity: 'base', numeric: true });
    const dir = sort === 'text-desc' ? -1 : 1;
    s.sort((a, b) => dir * coll.compare(a.text, b.text) || byDate(a, b));
  }
  return s;
}

/** Hvor mange filtre (ud over sortering) er slået til? */
export const activeFilterCount = (f: TxFilter) =>
  [f.q.trim(), f.accountId, f.categoryId, f.type !== 'all', f.status !== 'all', f.from || f.to, amountActive(f), f.withNote].filter(Boolean).length;

/** Er der et beløbsfilter, der faktisk filtrerer? */
export function amountActive(f: TxFilter): boolean {
  const a = !!f.min?.trim(), b = !!f.max?.trim();
  return f.amountOp === 'gt' || f.amountOp === 'eq' ? a : f.amountOp === 'lt' ? b : a || b;
}
