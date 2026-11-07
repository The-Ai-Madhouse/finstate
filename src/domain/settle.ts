/**
 * Afstemning af poster, der følger overførsler (udlæg, tilgodehavender, gæld til personer):
 * hvilke bevægelser hører sammen, og går de op?
 */
import { isBalanceRef, type Ledger } from './ledger';
import type { Account, AppData, Match } from './types';
import { dayDiff, uid } from './util';

export interface SettleItem {
  key: string;
  date: string;
  text: string;
  /** Effekt på postens saldo (+ = posten stiger, fx "Jonas skylder mig" mere). */
  amount: number;
  txId?: string;
  openItemId?: string;
  matchId?: string;
}

export interface SettleGroup {
  match: Match;
  items: SettleItem[];
  sum: number;
}

/** Alle bevægelser på posten (transaktioner og åbne poster), én pr. transaktion. */
export function settleItems(data: AppData, ledger: Ledger, accountId: string): SettleItem[] {
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

export function settleState(data: AppData, ledger: Ledger, accountId: string) {
  const items = settleItems(data, ledger, accountId);
  const groups: SettleGroup[] = (data.matches ?? [])
    .filter((m) => m.accountId === accountId)
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
export function writeOffDifference(d: AppData, ledger: Ledger, matchId: string, categoryId: string): AppData {
  const m = d.matches.find((x) => x.id === matchId);
  if (!m) return d;
  const acc = d.accounts.find((a) => a.id === m.accountId);
  const g = settleState(d, ledger, m.accountId).groups.find((x) => x.match.id === matchId);
  if (!g || !g.sum || !acc) return d;
  const id = uid('oi');
  const date = g.items[g.items.length - 1].date;
  return {
    ...d,
    openItems: [...d.openItems, { id, date, counterparty: acc.name, accountId: acc.id, amount: -g.sum, categoryId, note: 'Afskrevet difference' }],
    matches: d.matches.map((x) => (x.id === matchId ? { ...x, keys: [...x.keys, `oi:${id}`] } : x)),
  };
}
