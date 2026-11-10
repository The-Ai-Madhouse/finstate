import type { CatTotal, Ledger, Statement } from './ledger';
import type { Category, Period } from './types';
import { ancestors, categoryPath } from './categories';
import { elapsedEnd } from './periods';
import { dayDiff } from './util';

/** Gennemsnitlig månedslængde i dage (365,2425 / 12). */
export const DAYS_PER_MONTH = 30.436875;

/** Periodens længde i måneder ud fra det faktiske antal dage (inkl. begge endepunkter). */
export function periodDays(p: Pick<Period, 'start' | 'end'>): number {
  return dayDiff(p.start, p.end) + 1;
}
export function periodMonths(p: Pick<Period, 'start' | 'end'>): number {
  return periodDays(p) / DAYS_PER_MONTH;
}

/** Beløb i perioden → gennemsnit pr. måned (øre, afrundet). */
export const perMonth = (amount: number, months: number) => (months > 0 ? Math.round(amount / months) : 0);

const PASSIVE_NAME = /rente|afkast|udbytte|investering|aktie|depot|leje|passiv/i;

/**
 * Passiv? Indtægt: penge der arbejder for dig (renter, afkast …) – gættes ud fra navnet, hvis du ikke har valgt.
 * Udgift: faste udgifter der løber af sig selv (abonnementer, husleje …) – kun hvis du selv har markeret dem.
 */
export function isPassive(categories: Category[], id: string): boolean {
  const path = ancestors(categories, id.replace(/#own$/, ''));
  if (!path.length) return false;
  // Dit eget valg på kategorien eller nærmeste overkategori afgør.
  for (let i = path.length - 1; i >= 0; i--) if (path[i].passive !== undefined) return path[i].passive!;
  if (path[path.length - 1].kind === 'expense') return false;
  return path.some((c) => PASSIVE_NAME.test(c.name));
}

/** Passive beløb (indtægter eller udgifter) – på det dybeste niveau, så fx "Andet › Renter" tæller med. */
export function passiveIncome(categories: Category[], list: CatTotal[]): number {
  let sum = 0;
  for (const n of list) sum += n.children.length ? passiveIncome(categories, n.children) : isPassive(categories, n.own ? n.cats[0] : n.id) ? n.amount : 0;
  return sum;
}

export interface Cashflow {
  days: number;
  months: number;
  incomeM: number;
  expenseM: number;
  cashflowM: number;
  passive: number;
  passiveM: number;
  /** Faste udgifter, du selv har markeret som passive. */
  passiveExpense: number;
  passiveExpenseM: number;
  /** Andel af udgifterne, den passive indkomst dækker (Rich Dad: >= 100 % = ude af rotteræset). */
  passiveCoverage: number | null;
}

export function cashflow(s: Statement, categories: Category[]): Cashflow {
  // Et igangværende år: gennemsnit over de måneder, der er gået.
  const span = { start: s.period.start, end: elapsedEnd(s.period) };
  const months = periodMonths(span);
  const passive = passiveIncome(categories, s.income);
  const passiveExpense = passiveIncome(categories, s.expense);
  const incomeM = perMonth(s.incomeTotal, months);
  const expenseM = perMonth(s.expenseTotal, months);
  return {
    days: periodDays(span),
    months,
    incomeM,
    expenseM,
    cashflowM: incomeM - expenseM,
    passive,
    passiveM: perMonth(passive, months),
    passiveExpense,
    passiveExpenseM: perMonth(passiveExpense, months),
    // Har du markeret passive udgifter, måles dækningen mod dem; ellers mod alle udgifter.
    passiveCoverage: passiveExpense > 0 ? passive / passiveExpense : s.expenseTotal > 0 ? passive / s.expenseTotal : null,
  };
}

export interface FixedRow {
  /** Den øverste kategori, du har markeret som fast (dens underkategorier tæller med). */
  id: string;
  label: string;
  /** Beløb pr. måned (positive = udgift), samme rækkefølge som months. */
  byMonth: number[];
  total: number;
}

/** "2025-03" for hver måned i perioden – for et igangværende år kun til og med i dag. */
export function monthsOf(p: Pick<Period, 'start' | 'end'>): string[] {
  const end = elapsedEnd(p).slice(0, 7);
  const out: string[] = [];
  let [y, m] = p.start.slice(0, 7).split('-').map(Number);
  for (let k = `${y}-${String(m).padStart(2, '0')}`; k <= end; k = `${y}-${String(m).padStart(2, '0')}`) {
    out.push(k);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Faste udgifter måned for måned: én række pr. kategori, du har markeret som fast
 * (den øverste markerede i træet – underkategorier tæller med, medmindre de er fravalgt).
 */
export function fixedExpensesByMonth(categories: Category[], ledger: Ledger, p: Pick<Period, 'start' | 'end'>) {
  const months = monthsOf(p);
  const idx = new Map(months.map((m, i) => [m, i]));
  const rowOf = new Map<string, string | null>();
  const rowFor = (catId: string): string | null => {
    if (rowOf.has(catId)) return rowOf.get(catId)!;
    const path = ancestors(categories, catId);
    let row: string | null = null;
    if (path.length && path[0].kind === 'expense' && isPassive(categories, catId)) row = (path.find((c) => isPassive(categories, c.id)) ?? path[path.length - 1]).id;
    rowOf.set(catId, row);
    return row;
  };
  const rows = new Map<string, FixedRow>();
  for (const x of ledger.postings) {
    if (!x.ref.startsWith('cat:') || x.date < p.start || x.date > p.end) continue;
    const i = idx.get(x.date.slice(0, 7));
    if (i === undefined) continue;
    const id = rowFor(x.ref.slice(4));
    if (!id) continue;
    const r = rows.get(id) ?? rows.set(id, { id, label: categoryPath(categories, id), byMonth: months.map(() => 0), total: 0 }).get(id)!;
    r.byMonth[i] -= x.amount;
    r.total -= x.amount;
  }
  const list = [...rows.values()].sort((a, b) => b.total - a.total);
  const totals = months.map((_, i) => list.reduce((s, r) => s + r.byMonth[i], 0));
  return { months, rows: list, totals, total: totals.reduce((s, v) => s + v, 0) };
}
