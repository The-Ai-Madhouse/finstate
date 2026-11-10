/**
 * Periodens økonomi måned for måned – til indsigterne nederst i regnskabet:
 * indtægter, udgifter, resultat, nettoformue og udgifter pr. hovedkategori.
 */
import { ancestors } from './categories';
import { balancesAt, isBalanceRef, type Ledger } from './ledger';
import { addDays } from './util';
import { elapsedEnd } from './periods';
import type { Category, Period, Tx } from './types';

export interface MonthRow {
  /** "2025-03" */
  month: string;
  income: number;
  expense: number;
  /** income − expense */
  net: number;
  /** Nettoformue (egenkapital) ved månedens udgang. */
  equity: number;
  /** Udgifter pr. hovedkategori (id → beløb, positivt = udgift). */
  byCategory: Map<string, number>;
}

/** Månederne i perioden – for et igangværende år kun til og med i dag. */
export function monthsOf(p: Pick<Period, 'start' | 'end'>, today?: string): string[] {
  const end = elapsedEnd(p, today).slice(0, 7);
  const out: string[] = [];
  let [y, m] = p.start.slice(0, 7).split('-').map(Number);
  for (;;) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    if (k > end) break;
    out.push(k);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
};

export function monthlyRows(categories: Category[], ledger: Ledger, p: Pick<Period, 'start' | 'end'>, today?: string): MonthRow[] {
  const months = monthsOf(p, today);
  const rows = new Map(months.map((m) => [m, { month: m, income: 0, expense: 0, net: 0, equity: 0, byCategory: new Map<string, number>() } as MonthRow]));
  const kindOf = new Map(categories.map((c) => [c.id, c.kind]));
  const rootOf = new Map<string, string>();
  const root = (id: string) => rootOf.get(id) ?? rootOf.set(id, ancestors(categories, id)[0]?.id ?? id).get(id)!;
  // En "begge veje"-kategori står i regnskabet efter periodens nettobeløb – samme side her, så månederne summer til regnskabet.
  const bothNet = new Map<string, number>();
  for (const x of ledger.postings) {
    if (x.date < p.start || x.date > p.end || !x.ref.startsWith('cat:')) continue;
    const id = x.ref.slice(4);
    if (kindOf.get(id) !== 'both') continue;
    const r0 = root(id);
    bothNet.set(r0, (bothNet.get(r0) ?? 0) + x.amount);
  }
  for (const x of ledger.postings) {
    if (x.date < p.start || x.date > p.end) continue;
    const r = rows.get(x.date.slice(0, 7));
    if (!r) continue;
    let catId: string | undefined;
    let kind: Category['kind'] | undefined;
    if (x.ref.startsWith('cat:')) { catId = x.ref.slice(4); kind = kindOf.get(catId) ?? (x.amount >= 0 ? 'income' : 'expense'); }
    else if (x.ref === 'uncat:income') kind = 'income';
    else if (x.ref === 'uncat:expense') kind = 'expense';
    else continue;
    // En refusion trækker fra udgiften (og omvendt).
    const isIncome = kind === 'income' || (kind === 'both' && (bothNet.get(root(catId!)) ?? 0) >= 0);
    if (isIncome) r.income += x.amount;
    else {
      r.expense -= x.amount;
      const k = catId ? root(catId) : 'uncat';
      r.byCategory.set(k, (r.byCategory.get(k) ?? 0) - x.amount);
    }
  }
  for (const r of rows.values()) {
    r.net = r.income - r.expense;
    const b = balancesAt(ledger, monthEnd(r.month) > p.end ? p.end : monthEnd(r.month));
    let eq = 0;
    for (const [ref, v] of b) if (isBalanceRef(ref)) eq += v;
    r.equity = eq;
  }
  return [...rows.values()];
}

/** De største udgiftskategorier i perioden (hovedkategorier), så resten samles i "Andet". */
export function topExpenseCategories(rows: MonthRow[], n = 5): string[] {
  const tot = new Map<string, number>();
  for (const r of rows) for (const [k, v] of r.byCategory) tot.set(k, (tot.get(k) ?? 0) + v);
  return [...tot].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

/** Største enkeltudgift i perioden (bankens beløb). */
export function biggestExpense(txs: Tx[], p: Pick<Period, 'start' | 'end'>, isExpense: (t: Tx) => boolean): Tx | undefined {
  let best: Tx | undefined;
  for (const t of txs) if (t.date >= p.start && t.date <= p.end && t.amount < 0 && isExpense(t) && (!best || t.amount < best.amount)) best = t;
  return best;
}
