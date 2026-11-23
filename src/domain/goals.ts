/**
 * Opsparingsmål – kun planlægning: hvad skal der til for at nå målet, og er det realistisk?
 * Flytter ingen penge og påvirker hverken regnskabet eller det daglige budget.
 *
 * Realismen måles mod dine egne bankdata: hvad du i snit har tilbage pr. måned (indtægter minus udgifter, uden interne
 * overførsler) i de seneste hele måneder.
 */
import type { Resolved } from './classify';
import type { AppData, Goal, GoalKind } from './types';
import { dayDiff } from './util';

export const GOAL_KINDS: { id: GoalKind; label: string; icon: string }[] = [
  { id: 'travel', label: 'Rejse', icon: '✈' },
  { id: 'holiday', label: 'Ferie', icon: '☀' },
  { id: 'buffer', label: 'Buffer', icon: '⛑' },
  { id: 'car', label: 'Bil', icon: '🚗' },
  { id: 'home', label: 'Bolig', icon: '⌂' },
  { id: 'gift', label: 'Gave/fest', icon: '🎁' },
  { id: 'education', label: 'Uddannelse', icon: '🎓' },
  { id: 'other', label: 'Andet', icon: '★' },
];
export const kindOf = (k: GoalKind) => GOAL_KINDS.find((x) => x.id === k) ?? GOAL_KINDS[GOAL_KINDS.length - 1];
export const PRIORITY_LABEL: Record<Goal['priority'], string> = { 1: 'Høj', 2: 'Mellem', 3: 'Lav' };

const pad = (n: number) => String(n).padStart(2, '0');
/** Samme dag i måneden `n` måneder senere (sidste dag, hvis måneden er kortere). */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

/** Hele måneder fra i dag til datoen (mindst 1, hvis datoen ligger i fremtiden). Man sparer typisk op én gang om måneden. */
export function monthsUntil(today: string, date: string): number {
  if (date <= today) return 0;
  const [y1, m1, d1] = today.split('-').map(Number);
  const [y2, m2, d2] = date.split('-').map(Number);
  const m = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  return Math.max(1, m);
}

export const goalTarget = (g: Goal) => (g.costs?.length ? g.costs.reduce((s, c) => s + c.amount, 0) : g.target);

export type GoalStatus = 'done' | 'overdue' | 'ontrack' | 'behind' | 'noplan' | 'open';

export interface GoalPlan {
  target: number;
  saved: number;
  left: number;
  /** Andel nået (0–1). */
  progress: number;
  monthsLeft?: number;
  /** Det, der skal spares pr. måned for at nå målet til tiden (øre, rundet op til hele kroner). */
  needPerMonth?: number;
  /** Med din plan pr. måned: hvor mange måneder og hvornår du når det. */
  monthsAtPlan?: number;
  reachedAt?: string;
  /** Måneder for sent (positiv) eller før tid (negativ) med din plan. */
  lateBy?: number;
  status: GoalStatus;
}

const ceilKr = (ore: number) => Math.ceil(ore / 100) * 100;

export function goalPlan(g: Goal, today: string): GoalPlan {
  const target = goalTarget(g);
  const saved = Math.max(0, g.saved);
  const left = Math.max(0, target - saved);
  const progress = target > 0 ? Math.min(1, saved / target) : 0;
  const base = { target, saved, left, progress };
  if (left === 0 && target > 0) return { ...base, status: 'done' };
  const monthsLeft = g.deadline ? monthsUntil(today, g.deadline) : undefined;
  const needPerMonth = monthsLeft ? ceilKr(left / monthsLeft) : undefined;
  const monthsAtPlan = g.monthly && g.monthly > 0 ? Math.ceil(left / g.monthly) : undefined;
  const reachedAt = monthsAtPlan !== undefined ? addMonths(today, monthsAtPlan) : undefined;
  const lateBy = monthsAtPlan !== undefined && monthsLeft !== undefined ? monthsAtPlan - monthsLeft : undefined;
  const status: GoalStatus = g.deadline && monthsLeft === 0 ? 'overdue'
    : monthsAtPlan === undefined ? (g.deadline ? 'noplan' : 'open')
    : lateBy !== undefined && lateBy > 0 ? 'behind' : 'ontrack';
  return { ...base, monthsLeft, needPerMonth, monthsAtPlan, reachedAt, lateBy, status };
}

export interface Capacity {
  /** Antal hele måneder, gennemsnittet bygger på. */
  months: number;
  from: string;
  to: string;
  income: number;
  /** Udgifter (positivt tal). */
  expense: number;
  /** Tilbage pr. måned i snit = indtægter − udgifter. */
  net: number;
}

/**
 * Hvad du i snit har tilbage pr. måned: indtægter minus udgifter i de seneste hele måneder med bankdata (højst 6),
 * uden interne overførsler (fx til opsparingen – det er jo netop det, der kan spares).
 */
export function savingsCapacity(data: AppData, resolved: Map<string, Resolved>, maxMonths = 6): Capacity | undefined {
  const bank = new Set(data.accounts.filter((a) => a.kind === 'bank').map((a) => a.id));
  const txs = data.txs.filter((t) => bank.has(t.accountId) && t.date > data.settings.bookStart);
  if (!txs.length) return undefined;
  const first = txs.reduce((m, t) => (t.date < m ? t.date : m), txs[0].date);
  const last = txs.reduce((m, t) => (t.date > m ? t.date : m), txs[0].date);
  // Kun hele måneder: den første måned tæller, hvis data starter den 1.–5.; den sidste, hvis data går til slutningen af måneden.
  const nextMonthStart = (ym: string) => addMonths(`${ym}-01`, 1);
  const lastFull = dayDiff(last, nextMonthStart(last.slice(0, 7))) <= 3 ? last.slice(0, 7) : addMonths(`${last.slice(0, 7)}-01`, -1).slice(0, 7);
  const firstFull = Number(first.slice(8, 10)) <= 5 ? first.slice(0, 7) : addMonths(`${first.slice(0, 7)}-01`, 1).slice(0, 7);
  if (lastFull < firstFull) return undefined;
  const months: string[] = [];
  for (let m = lastFull; m >= firstFull && months.length < maxMonths; m = addMonths(`${m}-01`, -1).slice(0, 7)) months.unshift(m);
  const set = new Set(months);
  let income = 0, expense = 0;
  for (const t of txs) {
    if (!set.has(t.date.slice(0, 7))) continue;
    for (const l of resolved.get(t.id)?.lines ?? []) {
      if (l.type === 'income') income += l.amount;
      else if (l.type === 'expense') expense -= l.amount;
    }
  }
  const n = months.length;
  return { months: n, from: months[0], to: months[n - 1], income: Math.round(income / n), expense: Math.round(expense / n), net: Math.round((income - expense) / n) };
}

export type Verdict = 'realistic' | 'tight' | 'unrealistic' | 'unknown';

export interface GoalsOverview {
  plans: Map<string, GoalPlan>;
  /** Hvad alle aktive mål med en dato kræver pr. måned tilsammen. */
  needPerMonth: number;
  /** Hvad du selv har planlagt at spare pr. måned tilsammen. */
  plannedPerMonth: number;
  left: number;
  capacity?: Capacity;
  /** Andel af dit månedlige overskud, målene kræver. */
  share?: number;
  verdict: Verdict;
}

export function goalsOverview(goals: Goal[], today: string, capacity?: Capacity): GoalsOverview {
  const plans = new Map(goals.map((g) => [g.id, goalPlan(g, today)]));
  const active = goals.filter((g) => plans.get(g.id)!.status !== 'done');
  const needPerMonth = active.reduce((s, g) => s + (plans.get(g.id)!.needPerMonth ?? 0), 0);
  const plannedPerMonth = active.reduce((s, g) => s + (g.monthly ?? 0), 0);
  const left = active.reduce((s, g) => s + plans.get(g.id)!.left, 0);
  const demand = Math.max(needPerMonth, plannedPerMonth);
  const share = capacity && capacity.net > 0 ? demand / capacity.net : undefined;
  const verdict: Verdict = !capacity || demand === 0 ? 'unknown'
    : capacity.net <= 0 ? 'unrealistic'
    : share! <= 0.8 ? 'realistic' : share! <= 1 ? 'tight' : 'unrealistic';
  return { plans, needPerMonth, plannedPerMonth, left, capacity, share, verdict };
}

/** Forslag til en buffer: 3 måneders faste udgifter (fra Abonnementer). */
export const bufferSuggestion = (fixedPerMonth: number) => ceilKr(fixedPerMonth * 3);
