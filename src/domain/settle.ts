/**
 * Afstemning af poster, der følger overførsler (udlæg, tilgodehavender, gæld til personer):
 * hvilke bevægelser hører sammen, og går de op?
 */
import { balancesAt, isBalanceRef, type Ledger } from './ledger';
import type { Account, AppData, Match, Period } from './types';
import { addDays, dayDiff, uid } from './util';

export interface SettleItem {
  key: string;
  date: string;
  text: string;
  /** Effekt på postens saldo (+ = posten stiger, fx "Jonas skylder mig" mere). */
  amount: number;
  txId?: string;
  openItemId?: string;
  matchId?: string;
  /** Saldoen fra før perioden, samlet i én linje (kan parres med periodens bevægelser). */
  primo?: boolean;
}

export interface SettleGroup {
  match: Match;
  items: SettleItem[];
  sum: number;
}

/** Nøglen for "saldo primo" i en periode. */
export const primoKey = (p: Pick<Period, 'start'>) => `primo:${p.start}`;

/**
 * Bevægelserne på posten (transaktioner og åbne poster), én pr. transaktion.
 * Med en periode: KUN periodens bevægelser – alt fra før perioden står samlet som "Saldo primo".
 */
export function settleItems(data: AppData, ledger: Ledger, accountId: string, period?: Pick<Period, 'start' | 'end'>): SettleItem[] {
  const all = allItems(data, ledger, accountId);
  if (!period) return all;
  const ref = `acc:${accountId}`;
  const before = addDays(period.start, -1);
  const primo = balancesAt(ledger, before).get(ref) ?? 0;
  const key = primoKey(period);
  const matchId = (data.matches ?? []).find((m) => m.accountId === accountId && m.keys.includes(key))?.id;
  const inP = all.filter((i) => i.date >= period.start && i.date <= period.end);
  return primo ? [{ key, date: before, text: 'Saldo primo – fra før perioden', amount: primo, primo: true, matchId }, ...inP] : inP;
}

function allItems(data: AppData, ledger: Ledger, accountId: string): SettleItem[] {
  const ref = `acc:${accountId}`;
  const byKey = new Map<string, SettleItem>();
  const matchOf = new Map<string, string>();
  for (const m of data.matches ?? []) if (m.accountId === accountId) for (const k of m.keys) matchOf.set(k, m.id);
  const txs = new Map(data.txs.map((t) => [t.id, t]));
  const ois = new Map(data.openItems.map((o) => [o.id, o]));
  for (const p of ledger.postings) {
    if (p.ref !== ref || !isBalanceRef(p.ref) || p.valuationId) continue;
    const key = p.txId ? `tx:${p.txId}` : p.openItemId ? `oi:${p.openItemId}` : undefined;
    if (!key) continue;
    const cur = byKey.get(key);
    if (cur) { cur.amount += p.amount; continue; }
    const t = p.txId ? txs.get(p.txId) : undefined;
    const o = p.openItemId ? ois.get(p.openItemId) : undefined;
    const text = t ? (t.memo ? `${t.text} – ${t.memo}` : t.text) : o?.note ?? (o?.categoryId ? 'Afskrivning' : 'Startsaldo');
    byKey.set(key, { key, date: p.date, text, amount: p.amount, txId: p.txId, openItemId: p.openItemId, matchId: matchOf.get(key) });
  }
  return [...byKey.values()].filter((i) => i.amount !== 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Skal posten afstemmes? Brugerens valg – ellers ja, hvis den allerede har grupper. */
export const isSettled = (d: Pick<AppData, 'matches'>, a: Pick<Account, 'id' | 'settle' | 'kind'>) =>
  a.kind === 'tracked' && (a.settle ?? (d.matches ?? []).some((m) => m.accountId === a.id));

export function settleState(data: AppData, ledger: Ledger, accountId: string, period?: Pick<Period, 'start' | 'end'>) {
  const items = settleItems(data, ledger, accountId, period);
  // En gruppe hører kun til perioden, hvis ALLE dens bevægelser ligger i perioden (eller er periodens saldo primo).
  // Grupper på tværs af perioder vises ikke – deres bevægelser står som uparrede her.
  const inScope = new Set(items.map((i) => i.key));
  const existing = period ? new Set(allItems(data, ledger, accountId).map((i) => i.key)) : inScope;
  const valid = (m: Match) => m.keys.every((k) => inScope.has(k) || (!existing.has(k) && !k.startsWith('primo:')));
  const groups: SettleGroup[] = (data.matches ?? [])
    .filter((m) => m.accountId === accountId && valid(m))
    .map((match) => {
      const its = items.filter((i) => i.matchId === match.id);
      return { match, items: its, sum: its.reduce((s, i) => s + i.amount, 0) };
    })
    .filter((g) => g.items.length > 0)
    .sort((a, b) => (a.items[0].date < b.items[0].date ? -1 : 1));
  const open = items.filter((i) => !i.matchId || !groups.some((g) => g.match.id === i.matchId));
  return { items, groups, open, openSum: open.reduce((s, i) => s + i.amount, 0), suggestions: suggestPairs(open) };
}

/** Forslag: to åbne bevægelser med præcis modsat beløb – tætteste dato først, hver bruges højst én gang. */
export function suggestPairs(open: SettleItem[]): [SettleItem, SettleItem][] {
  const cands: { a: SettleItem; b: SettleItem; d: number }[] = [];
  for (const a of open) for (const b of open) if (a.amount > 0 && b.amount === -a.amount) cands.push({ a, b, d: Math.abs(dayDiff(a.date, b.date)) });
  cands.sort((x, y) => x.d - y.d);
  const used = new Set<string>();
  const out: [SettleItem, SettleItem][] = [];
  for (const { a, b } of cands) {
    if (used.has(a.key) || used.has(b.key)) continue;
    used.add(a.key); used.add(b.key);
    out.push(a.date <= b.date ? [a, b] : [b, a]);
  }
  return out;
}

/** Par bevægelser i en ny gruppe (eller føj dem til en eksisterende). Nøglerne fjernes fra andre grupper. */
export function pairItems(d: AppData, accountId: string, keys: string[], intoMatchId?: string): AppData {
  const ks = new Set(keys);
  let matches = (d.matches ?? []).map((m) => (m.accountId === accountId ? { ...m, keys: m.keys.filter((k) => !ks.has(k)) } : m));
  if (intoMatchId && matches.some((m) => m.id === intoMatchId)) {
    matches = matches.map((m) => (m.id === intoMatchId ? { ...m, keys: [...m.keys, ...keys] } : m));
  } else {
    matches = [...matches, { id: uid('match'), accountId, keys: [...keys] }];
  }
  return { ...d, matches: matches.filter((m) => m.keys.length > 0) };
}

export function unpair(d: AppData, matchId: string, key?: string): AppData {
  const matches = (d.matches ?? [])
    .map((m) => (m.id !== matchId ? m : key ? { ...m, keys: m.keys.filter((k) => k !== key) } : { ...m, keys: [] }))
    .filter((m) => m.keys.length > 0);
  return { ...d, matches };
}

/**
 * Afskriv gruppens difference som indtægt/udgift (fx "Jonas betalte 50 kr for lidt – lad det gå"):
 * en åben post med kategori, der bringer gruppen i 0, dateret ved gruppens seneste bevægelse.
 */
export function writeOffDifference(d: AppData, ledger: Ledger, matchId: string, categoryId: string, period?: Pick<Period, 'start' | 'end'>): AppData {
  const m = d.matches.find((x) => x.id === matchId);
  if (!m) return d;
  const acc = d.accounts.find((a) => a.id === m.accountId);
  const g = settleState(d, ledger, m.accountId, period).groups.find((x) => x.match.id === matchId);
  if (!g || !g.sum || !acc) return d;
  const id = uid('oi');
  // Afskrivningen bogføres i perioden – aldrig før den (fx hvis gruppen kun er saldo primo).
  const last = g.items[g.items.length - 1].date;
  const date = period && last < period.start ? period.start : last;
  return {
    ...d,
    openItems: [...d.openItems, { id, date, counterparty: acc.name, accountId: acc.id, amount: -g.sum, categoryId, note: 'Afskrevet difference' }],
    matches: d.matches.map((x) => (x.id === matchId ? { ...x, keys: [...x.keys, `oi:${id}`] } : x)),
  };
}
