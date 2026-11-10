import type { CatTotal, Statement } from './ledger';
import type { Category, Period } from './types';
import { ancestors } from './categories';
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
