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
  status: 'all' | 'pending' | 'done';
  from?: string;
  to?: string;
  min?: string;
  max?: string;
  withNote: boolean;
  sort: 'date-asc' | 'date-desc' | 'amount-desc' | 'amount-asc';
}

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
    if (min !== null && Math.abs(t.amount) < Math.abs(min)) return false;
    if (max !== null && Math.abs(t.amount) > Math.abs(max)) return false;
    if (f.withNote && !t.note && !t.memo) return false;
    if (f.status === 'pending' && !NEEDS_REVIEW.has(r.source)) return false;
    if (f.status === 'done' && NEEDS_REVIEW.has(r.source)) return false;
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
  else s.sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount) || byDate(a, b));
  return s;
}

/** Hvor mange filtre (ud over sortering) er slået til? */
export const activeFilterCount = (f: TxFilter) =>
  [f.q.trim(), f.accountId, f.categoryId, f.type !== 'all', f.status !== 'all', f.from, f.to, f.min?.trim(), f.max?.trim(), f.withNote].filter(Boolean).length;
