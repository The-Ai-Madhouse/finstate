/**
 * Hvad er ændret mellem to versioner af dine data? Til versionsstyringen ("ændringer siden …").
 * Klassifikationer sammenlignes på det, der faktisk gælder (dit valg, regler, forslag), ikke kun dine egne felter.
 */
import { categoryPath } from './categories';
import { resolveAll, type Resolved } from './classify';
import type { Account, AppData, Category, Tx } from './types';

export interface DataDiff {
  txAdded: Tx[];
  txRemoved: Tx[];
  /** Kategori/type/post er ændret. */
  txChanged: { tx: Tx; before: string; after: string }[];
  /** Din egen note på transaktionen er ændret. */
  notesChanged: { tx: Tx; before?: string; after?: string }[];
  catAdded: Category[];
  catRemoved: Category[];
  /** Omdøbt eller flyttet i træet. */
  catChanged: { before: string; after: string }[];
  accAdded: Account[];
  accRemoved: Account[];
  accChanged: { name: string; what: string }[];
  valuations: { account: string; date: string; before?: number; after?: number }[];
  periodsAdded: string[];
  periodsRemoved: string[];
  /** Parringer og afstemning (antal grupper/valg før → efter). */
  pairing: { label: string; before: number; after: number }[];
  total: number;
}

function lineLabel(d: AppData, r?: Resolved): string {
  if (!r) return '–';
  const one = (l: Resolved['lines'][number]) => {
    if (l.type === 'internal') return `Intern → ${d.accounts.find((a) => a.id === l.targetAccountId)?.name ?? (l.transitRef ? 'penge undervejs' : '?')}`;
    if (l.type === 'outlay') return `Udlæg · ${l.counterparty ?? ''}`;
    const cat = l.categoryId ? categoryPath(d.categories, l.categoryId) || l.categoryId : 'ukategoriseret';
    return `${l.type === 'income' ? 'Indtægt' : 'Udgift'} · ${cat}`;
  };
  return r.lines.length > 1 ? `Opdelt: ${r.lines.map(one).join(' + ')}` : one(r.lines[0]);
}

const lineKey = (r?: Resolved) => JSON.stringify(r?.lines.map((l) => [l.type, l.categoryId, l.targetAccountId, l.transitRef, l.counterparty, l.amount]) ?? null);

export function diffData(before: AppData, after: AppData): DataDiff {
  const rb = resolveAll(before), ra = resolveAll(after);
  const bTx = new Map(before.txs.map((t) => [t.id, t]));
  const aTx = new Map(after.txs.map((t) => [t.id, t]));
  const txAdded = after.txs.filter((t) => !bTx.has(t.id));
  const txRemoved = before.txs.filter((t) => !aTx.has(t.id));
  const txChanged: DataDiff['txChanged'] = [];
  const notesChanged: DataDiff['notesChanged'] = [];
  for (const t of after.txs) {
    const o = bTx.get(t.id);
    if (!o) continue;
    // Sammenlign selve valget (ikke navnene) – en omdøbt kategori er ikke en ændret transaktion.
    if (lineKey(rb.get(t.id)) !== lineKey(ra.get(t.id))) txChanged.push({ tx: t, before: lineLabel(before, rb.get(t.id)), after: lineLabel(after, ra.get(t.id)) });
    if ((o.memo ?? '') !== (t.memo ?? '')) notesChanged.push({ tx: t, before: o.memo, after: t.memo });
  }

  const bCat = new Map(before.categories.map((c) => [c.id, c]));
  const aCat = new Map(after.categories.map((c) => [c.id, c]));
  const catAdded = after.categories.filter((c) => !bCat.has(c.id));
  const catRemoved = before.categories.filter((c) => !aCat.has(c.id));
  const catChanged: DataDiff['catChanged'] = [];
  for (const c of after.categories) {
    if (!bCat.has(c.id)) continue;
    const pb = categoryPath(before.categories, c.id), pa = categoryPath(after.categories, c.id);
    if (pb !== pa) catChanged.push({ before: pb, after: pa });
  }

  const bAcc = new Map(before.accounts.map((a) => [a.id, a]));
  const aAcc = new Map(after.accounts.map((a) => [a.id, a]));
  const accAdded = after.accounts.filter((a) => !bAcc.has(a.id));
  const accRemoved = before.accounts.filter((a) => !aAcc.has(a.id));
  const accChanged: DataDiff['accChanged'] = [];
  const KIND: Record<Account['kind'], string> = { bank: 'bankkonto', tracked: 'følger overførsler', valuation: 'tastes selv' };
  for (const a of after.accounts) {
    const o = bAcc.get(a.id);
    if (!o) continue;
    if (o.name !== a.name) accChanged.push({ name: a.name, what: `omdøbt fra "${o.name}"` });
    if (o.kind !== a.kind) accChanged.push({ name: a.name, what: `${KIND[o.kind]} → ${KIND[a.kind]}` });
    if (o.typeId !== a.typeId) accChanged.push({ name: a.name, what: 'ny type' });
    if ((o.openingBalance ?? null) !== (a.openingBalance ?? null)) accChanged.push({ name: a.name, what: 'åbningssaldo ændret' });
  }

  const key = (v: { accountId: string; date: string }) => `${v.accountId}|${v.date}`;
  const bVal = new Map(before.valuations.map((v) => [key(v), v.value]));
  const aVal = new Map(after.valuations.map((v) => [key(v), v.value]));
  const valuations: DataDiff['valuations'] = [];
  for (const k of new Set([...bVal.keys(), ...aVal.keys()])) {
    if (bVal.get(k) === aVal.get(k)) continue;
    const [accountId, date] = k.split('|');
    valuations.push({ account: (aAcc.get(accountId) ?? bAcc.get(accountId))?.name ?? accountId, date, before: bVal.get(k), after: aVal.get(k) });
  }
  valuations.sort((x, y) => (x.date < y.date ? -1 : 1));

  const bP = new Map(before.periods.map((p) => [p.id, p.name]));
  const aP = new Map(after.periods.map((p) => [p.id, p.name]));
  const periodsAdded = [...aP].filter(([id]) => !bP.has(id)).map(([, n]) => n);
  const periodsRemoved = [...bP].filter(([id]) => !aP.has(id)).map(([, n]) => n);

  const groups = (d: AppData) => new Set(d.txs.filter((t) => t.link).map((t) => t.link)).size;
  const settled = (d: AppData) => d.periods.reduce((s, p) => s + (p.settle?.length ?? 0), 0);
  const pairing = [
    { label: 'Grupper i afstemningen', before: (before.matches ?? []).length, after: (after.matches ?? []).length },
    { label: 'Parrede transaktioner', before: groups(before), after: groups(after) },
    { label: 'Poster, der afstemmes', before: settled(before), after: settled(after) },
    { label: 'Afskrivninger', before: before.openItems.filter((o) => o.categoryId).length, after: after.openItems.filter((o) => o.categoryId).length },
  ].filter((x) => x.before !== x.after);

  const total = txAdded.length + txRemoved.length + txChanged.length + notesChanged.length + catAdded.length + catRemoved.length + catChanged.length
    + accAdded.length + accRemoved.length + accChanged.length + valuations.length + periodsAdded.length + periodsRemoved.length + pairing.length;
  return { txAdded, txRemoved, txChanged, notesChanged, catAdded, catRemoved, catChanged, accAdded, accRemoved, accChanged, valuations, periodsAdded, periodsRemoved, pairing, total };
}

/** Kort opsummering af en version (vises i listen uden at hente hele versionen). */
export function versionSummary(d: AppData) {
  const r = resolveAll(d);
  const decided = d.txs.filter((t) => { const s = r.get(t.id)?.source; return s === 'manual' || s === 'rule' || s === 'split' || s === 'pair' || s === 'alias'; }).length;
  return { txs: d.txs.length, decided, categories: d.categories.length, accounts: d.accounts.length, periods: d.periods.map((p) => p.name) };
}
