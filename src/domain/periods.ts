/**
 * Financial statements er årlige. I Regnskab kan man vælge kun at vise et halvår af året –
 * det er blot et udsnit (samme bogføring, samme poster og kommentarer), ikke en ny periode.
 */
import type { AppData, Period } from './types';
import { addDays, dayDiff } from './util';

export type Scope = 'year' | 'h1' | 'h2';

export const SCOPE_LABEL: Record<Scope, string> = { year: 'Hele året', h1: '1. halvår', h2: '2. halvår' };

/** Et kalenderår som financial statement. */
export const yearPeriod = (year: number): Period => ({ id: `p-${year}`, name: `${year}`, start: `${year}-01-01`, end: `${year}-12-31` });

/** Lægger hele måneder til en ISO-dato (dag 1 → dag 1). */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = y * 12 + (m - 1) + months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Halvårenes grænse: første dag i 2. halvår (start + 6 måneder). */
export const secondHalfStart = (p: Pick<Period, 'start'>) => addMonths(p.start, 6);

/** Udsnit af perioden. Id'et bevares, så kommentarer og poster følger med. */
export function scoped(p: Period, scope: Scope): Period {
  if (scope === 'year') return p;
  const mid = secondHalfStart(p);
  if (scope === 'h1') return { ...p, end: addDays(mid, -1), name: `${p.name} – ${SCOPE_LABEL.h1}` };
  return { ...p, start: mid, name: `${p.name} – ${SCOPE_LABEL.h2}` };
}

/** Er perioden endnu ikke slut (fx det igangværende år)? */
export const inProgress = (p: Pick<Period, 'end'>, today = new Date().toISOString().slice(0, 10)) => p.end > today;

/** Sidste dag, der er gået i perioden – til gennemsnit pr. måned for et igangværende år. */
export const elapsedEnd = (p: Pick<Period, 'start' | 'end'>, today = new Date().toISOString().slice(0, 10)) =>
  p.end <= today ? p.end : today < p.start ? p.start : today;

/** Kan udsnittet vises (2. halvår er først muligt, når det er begyndt)? */
export const scopeAvailable = (p: Period, scope: Scope, today = new Date().toISOString().slice(0, 10)) =>
  scope !== 'h2' || secondHalfStart(p) <= today;

/** Nøgle for en sammenligning: "<periode-id>" (hele året) eller "<periode-id>#h1"/"#h2". */
export const compareKey = (id: string, scope: Scope) => (scope === 'year' ? id : `${id}#${scope}`);

export function parseCompareKey(data: AppData, key?: string): Period | undefined {
  if (!key) return undefined;
  const [id, s] = key.split('#');
  const p = data.periods.find((x) => x.id === id);
  return p && scoped(p, (s as Scope) || 'year');
}

/**
 * Hvad udsnittet sammenlignes med: dit eget valg, ellers
 * hele året → forrige år · 2. halvår → 1. halvår samme år · 1. halvår → 2. halvår året før.
 */
export function compareFor(data: AppData, p: Period, scope: Scope): Period | undefined {
  const chosen = parseCompareKey(data, p.compareToId);
  if (chosen) return chosen;
  if (scope === 'h2') return scoped(p, 'h1');
  const len = dayDiff(p.start, p.end);
  const earlier = data.periods.filter((x) => x.end < p.start).sort((a, b) => (a.end < b.end ? 1 : -1));
  const prev = earlier.find((x) => Math.abs(dayDiff(x.start, x.end) - len) <= 5) ?? earlier[0];
  if (!prev) return undefined;
  return scope === 'h1' ? scoped(prev, 'h2') : prev;
}

/** Valgmuligheder til "Sammenlign med": hvert år og dets halvår (undtagen det, man ser på). */
export function compareOptions(data: AppData, p: Period, scope: Scope) {
  const out: { id: string; label: string }[] = [];
  for (const x of [...data.periods].sort((a, b) => (a.start < b.start ? 1 : -1))) {
    for (const s of ['year', 'h1', 'h2'] as Scope[]) {
      if (x.id === p.id && s === scope) continue;
      out.push({ id: compareKey(x.id, s), label: s === 'year' ? x.name : `${x.name} – ${SCOPE_LABEL[s]}` });
    }
  }
  return out;
}
