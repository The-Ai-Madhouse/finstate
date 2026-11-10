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

/** Afstemmes posten i perioden? Det vælges pr. periode (financial statement). */
export const isSettled = (period: Pick<Period, 'settle'> | undefined, a: Pick<Account, 'id' | 'kind'>) =>
  a.kind === 'tracked' && !!period?.settle?.includes(a.id);

/** Tilføj posten til (eller fjern den fra) afstemningen i én periode. Dens parringer bevares. */
export function withSettle(d: AppData, periodId: string, accountId: string, on: boolean): AppData {
  return {
    ...d,
    periods: d.periods.map((p) => {
      if (p.id !== periodId) return p;
      const rest = (p.settle ?? []).filter((id) => id !== accountId);
      return { ...p, settle: on ? [...rest, accountId] : rest };
    }),
  };
}

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
    // En parring kræver mindst to (fx hvis den anden er slettet, står den tilbageværende som uparret).
    .filter((g) => g.items.length > 1)
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

/** En afskrevet difference: en åben post med kategori, som hører til en gruppe. */
const isWriteOff = (d: Pick<AppData, 'openItems'>, k: string) => k.startsWith('oi:') && !!d.openItems.find((o) => o.id === k.slice(3))?.categoryId;

/**
 * Ryd op efter en ændring: grupper med færre end to rigtige bevægelser opløses (en afskrivning tæller ikke),
 * og afskrivninger, der ikke længere hører til en gruppe, slettes – så de ikke bliver stående som et beløb.
 */
function tidy(d: AppData, matches: Match[], dropOi: Set<string>): AppData {
  const keep: Match[] = [];
  for (const m of matches) {
    const real = m.keys.filter((k) => !isWriteOff(d, k));
    if (real.length < 2) { for (const k of m.keys) if (isWriteOff(d, k)) dropOi.add(k.slice(3)); continue; }
    keep.push(m);
  }
  const referenced = new Set(keep.flatMap((m) => m.keys));
  for (const k of [...dropOi]) if (referenced.has(`oi:${k}`)) dropOi.delete(k);
  return {
    ...d,
    matches: keep.map((m) => ({ ...m, keys: m.keys.filter((k) => !(k.startsWith('oi:') && dropOi.has(k.slice(3)))) })),
    openItems: dropOi.size ? d.openItems.filter((o) => !dropOi.has(o.id)) : d.openItems,
  };
}

/**
 * Tag bevægelser ud af deres grupper. Ændres en gruppe, passer en afskrevet difference ikke længere – den slettes.
 * Står der færre end to tilbage, opløses gruppen (med dens afskrivninger).
 */
export function removeFromMatches(d: AppData, keys: string[]): AppData {
  const ks = new Set(keys);
  const dropOi = new Set<string>();
  const matches = (d.matches ?? []).map((m) => {
    if (!m.keys.some((k) => ks.has(k))) return m;
    for (const k of m.keys) if (isWriteOff(d, k)) dropOi.add(k.slice(3));
    return { ...m, keys: m.keys.filter((k) => !ks.has(k) && !isWriteOff(d, k)) };
  });
  return tidy(d, matches, dropOi);
}

/** Par bevægelser i en ny gruppe (eller føj dem til en eksisterende). Nøglerne fjernes fra andre grupper. */
export function pairItems(d: AppData, accountId: string, keys: string[], intoMatchId?: string): AppData {
  let n = removeFromMatches(d, keys);
  let matches = n.matches ?? [];
  const dropOi = new Set<string>();
  if (intoMatchId && matches.some((m) => m.id === intoMatchId)) {
    // Gruppen ændres → en tidligere afskrivning passer ikke længere.
    matches = matches.map((m) => {
      if (m.id !== intoMatchId) return m;
      for (const k of m.keys) if (isWriteOff(n, k)) dropOi.add(k.slice(3));
      return { ...m, keys: [...m.keys.filter((k) => !isWriteOff(n, k)), ...keys] };
    });
  } else {
    matches = [...matches, { id: uid('match'), accountId, keys: [...keys] }];
  }
  n = tidy(n, matches, dropOi);
  return n;
}

/** Opløs en gruppe – eller tag én bevægelse ud af den. Afskrivninger i gruppen slettes med. */
export function unpair(d: AppData, matchId: string, key?: string): AppData {
  if (key) return removeFromMatches(d, [key]);
  const m = (d.matches ?? []).find((x) => x.id === matchId);
  if (!m) return d;
  const dropOi = new Set(m.keys.filter((k) => isWriteOff(d, k)).map((k) => k.slice(3)));
  return tidy(d, (d.matches ?? []).filter((x) => x.id !== matchId), dropOi);
}

/** Ved indlæsning: afskrivninger, som ikke længere hører til en gruppe (fx efter en ophævet parring), og grupper med kun én bevægelse. */
export function tidySettle(d: AppData): AppData {
  const referenced = new Set((d.matches ?? []).flatMap((m) => m.keys));
  const stray = d.openItems.filter((o) => o.categoryId && o.note === 'Afskrevet difference' && !referenced.has(`oi:${o.id}`)).map((o) => o.id);
  const lonely = (d.matches ?? []).some((m) => m.keys.filter((k) => !isWriteOff(d, k)).length < 2);
  if (!stray.length && !lonely) return d;
  return tidy(d, d.matches ?? [], new Set(stray));
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
