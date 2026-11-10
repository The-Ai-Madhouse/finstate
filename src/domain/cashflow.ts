import type { CatTotal, Statement } from './ledger';
import type { Category, Period } from './types';
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
  const c = categories.find((x) => x.id === id);
  if (!c) return false;
  if (c.passive !== undefined) return c.passive;
  const parent = c.parentId ? categories.find((x) => x.id === c.parentId) : undefined;
  if (parent?.passive !== undefined) return parent.passive;
  if (c.kind === 'expense') return false;
  return PASSIVE_NAME.test(c.name) || (!!parent && PASSIVE_NAME.test(parent.name));
}

/** Passive beløb i perioden (indtægter eller udgifter) – på underkategoriniveau, så fx "Andet › Renter" tæller med. */
export function passiveIncome(categories: Category[], income: CatTotal[]): number {
  let sum = 0;
  for (const top of income) {
    // Uden underkategorier: hovedkategorien afgør. Med: hver underkategori (og evt. "(uden underkategori)" = hovedkategorien).
    if (!top.children.length) {
      if (isPassive(categories, top.id)) sum += top.amount;
    } else {
      for (const ch of top.children) if (isPassive(categories, ch.id)) sum += ch.amount;
    }
  }
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
