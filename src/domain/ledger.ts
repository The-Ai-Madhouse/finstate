/**
 * Dobbelt bogholderi.
 *
 * Hver hændelse giver posteringer på to slags konti:
 *  - Balancekonti (aktiver positive, gæld negativ):
 *      acc:<id>   bank- og værdikonti
 *      transit    "Penge undervejs" – interne overførsler hvor modposten endnu ikke er bogført.
 *                 Pr. modtagende konto: transit:<konto-id> (hvor pengene forventes at lande); "transit" = ukendt.
 *      cp:<navn>  tilgodehavende (+) / gæld (−) over for en person (udlæg)
 *  - Egenkapitalkonti (beløb = effekt på egenkapital; indtægt +, udgift −):
 *      cat:<id>, uncat:income, uncat:expense, opening
 *
 * Invariant pr. hændelse: sum(balanceposteringer) = sum(egenkapitalposteringer).
 * Derfor gælder altid: Δ egenkapital = periodens resultat (+ evt. åbningsposter).
 */
import { childrenOf, descendants } from './categories';
import type { Resolved } from './classify';
import { orderChain, bankBalanceAt, type ChainBreak } from './reconcile';
import type { Account, AppData, Category, Period, Tx } from './types';
import { addDays, groupBy } from './util';

export interface Posting {
  date: string;
  ref: string;
  amount: number;
  txId?: string;
  valuationId?: string;
  openItemId?: string;
}

export const isTransitRef = (ref: string) => ref === 'transit' || ref.startsWith('transit:');
export const isBalanceRef = (ref: string) => ref.startsWith('acc:') || isTransitRef(ref) || ref.startsWith('cp:');
/** Hvilken konto venter pengene på (undefined = ukendt)? */
export const transitAccountId = (ref: string) => (ref.startsWith('transit:') ? ref.slice(8) : undefined);
export const cpRef = (name: string) => `cp:${name.trim().toLowerCase()}`;

export interface Ledger {
  postings: Posting[];
  cpLabels: Map<string, string>;
  chains: Map<string, { ordered: Tx[]; breaks: ChainBreak[] }>;
  warnings: string[];
}

export function buildLedger(data: AppData, resolved: Map<string, Resolved>): Ledger {
  const { bookStart } = data.settings;
  const accounts = new Map(data.accounts.map((a) => [a.id, a]));
  const postings: Posting[] = [];
  const cpLabels = new Map<string, string>();
  const warnings: string[] = [];
  const pl = (date: string, ref: string, amount: number, extra: Partial<Posting> = {}) =>
    amount !== 0 && postings.push({ date, ref, amount, ...extra });
  const cp = (name: string) => {
    const ref = cpRef(name);
    if (!cpLabels.has(ref)) cpLabels.set(ref, name.trim());
    return ref;
  };

  // --- Bankkonti: åbning + transaktioner
  const chains = new Map<string, { ordered: Tx[]; breaks: ChainBreak[] }>();
  const txByAcc = groupBy(data.txs, (t) => t.accountId);
  for (const acc of data.accounts.filter((a) => a.kind === 'bank')) {
    const chain = orderChain(txByAcc.get(acc.id) ?? []);
    chains.set(acc.id, chain);
    let opening = acc.openingBalance;
    if (opening === undefined) opening = bankBalanceAt(chain.ordered, bookStart);
    if (opening === undefined) {
      const first = chain.ordered.find((t) => t.date > bookStart);
      opening = first?.balance !== undefined ? first.balance - first.amount : 0;
    }
    pl(bookStart, `acc:${acc.id}`, opening);
    pl(bookStart, 'opening', opening);
  }

  for (const tx of data.txs) {
    if (tx.date <= bookStart) continue;
    if (!accounts.has(tx.accountId)) continue;
    const r = resolved.get(tx.id);
    if (!r) continue;
    const x = { txId: tx.id };
    pl(tx.date, `acc:${tx.accountId}`, tx.amount, x);
    for (const line of r.lines) {
      switch (line.type) {
        case 'income':
        case 'expense':
          pl(tx.date, line.categoryId ? `cat:${line.categoryId}` : `uncat:${line.type}`, line.amount, x);
          break;
        case 'internal': {
          const target = line.targetAccountId ? accounts.get(line.targetAccountId) : undefined;
          const direct = target && (target.kind !== 'bank' || !txByAcc.has(target.id));
          // Undervejs pr. modtager: penge ud venter på målkontoen; penge ind er landet på denne konto.
          const receiver = line.amount < 0 ? target?.id : tx.accountId;
          pl(tx.date, direct ? `acc:${target.id}` : receiver && target ? `transit:${receiver}` : 'transit', -line.amount, x);
          break;
        }
        case 'outlay':
          pl(tx.date, cp(line.counterparty || 'Ukendt'), -line.amount, x);
          break;
      }
    }
  }

  // --- Penge undervejs ved start
  pl(bookStart, 'transit', data.settings.openingTransit);
  pl(bookStart, 'opening', data.settings.openingTransit);

  // --- Åbne poster (tilgodehavender/gæld over for personer)
  for (const o of data.openItems) {
    const x = { openItemId: o.id };
    const ref = o.accountId && accounts.has(o.accountId) ? `acc:${o.accountId}` : cp(o.counterparty);
    if (o.categoryId) {
      pl(o.date, ref, o.amount, x);
      pl(o.date, `cat:${o.categoryId}`, o.amount, x);
    } else {
      pl(bookStart, ref, o.amount, x);
      pl(bookStart, 'opening', o.amount, x);
    }
  }

  // --- Værdikonti: værdiændring minus overførsler = afkast/renter m.m.
  const direct = postings.filter((p) => p.txId && p.ref.startsWith('acc:'));
  for (const acc of data.accounts.filter((a) => a.kind === 'valuation')) {
    const ref = `acc:${acc.id}`;
    const vals = data.valuations.filter((v) => v.accountId === acc.id).sort((a, b) => (a.date < b.date ? -1 : 1));
    const transfers = direct.filter((p) => p.ref === ref);
    const moved = (from: string, to: string) =>
      transfers.filter((p) => p.date > from && p.date <= to).reduce((s, p) => s + p.amount, 0);
    if (!vals.length) {
      if (transfers.length) warnings.push(`${acc.name}: der er overførsler, men ingen værdi angivet.`);
      continue;
    }
    const first = vals[0];
    if (first.date > bookStart) warnings.push(`${acc.name}: første værdi er ${first.date}. Angiv værdien pr. ${bookStart} for en korrekt åbningsbalance.`);
    const openVal = first.value - moved(bookStart, first.date);
    pl(bookStart, ref, openVal, { valuationId: first.id });
    pl(bookStart, 'opening', openVal, { valuationId: first.id });
    for (let i = 1; i < vals.length; i++) {
      const v = vals[i];
      const residual = v.value - vals[i - 1].value - moved(vals[i - 1].date, v.date);
      const x = { valuationId: v.id };
      pl(v.date, ref, residual, x);
      let rest = residual;
      for (const adj of v.adjustments) {
        pl(v.date, `cat:${adj.categoryId}`, adj.amount, x);
        rest -= adj.amount;
      }
      pl(v.date, acc.defaultCategoryId ? `cat:${acc.defaultCategoryId}` : rest >= 0 ? 'uncat:income' : 'uncat:expense', rest, x);
    }
  }

  postings.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { postings, cpLabels, chains, warnings };
}

export function balancesAt(ledger: Ledger, date: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of ledger.postings) {
    if (p.date > date) break;
    if (isBalanceRef(p.ref)) m.set(p.ref, (m.get(p.ref) ?? 0) + p.amount);
  }
  return m;
}

// ---------------------------------------------------------------- Opgørelse

export interface BsRow {
  ref: string;
  label: string;
  kind: 'bank' | 'valuation' | 'tracked' | 'transit' | 'cp';
  typeId?: string;
  /** Efter fortegnet: positiv saldo = aktiv, negativ = passiv (ved 0 bruges postens naturlige side). */
  side: 'asset' | 'liability';
  /** Fortegnsbestemt (aktiv +, gæld −). */
  open: number;
  close: number;
}

export interface CatTotal {
  id: string;
  name: string;
  /** Præsentationsbeløb: indtægter positive, udgifter positive (refusion trækker fra). */
  amount: number;
  /** Underkategorier (i vilkårlig dybde). Har kategorien også egne posteringer, står de som "(uden underkategori)". */
  children: CatTotal[];
  /** Kategorierne, hvis posteringer indgår i beløbet (hele undertræet – eller kun kategorien selv for "(uden underkategori)"). */
  cats: string[];
  /** "(uden underkategori)": beløb bogført direkte på en kategori, der også har underkategorier. id er "<kategori>#own". */
  own?: boolean;
}

export interface Statement {
  period: Period;
  rows: BsRow[];
  assetsOpen: number;
  assetsClose: number;
  liabOpen: number;
  liabClose: number;
  equityOpen: number;
  equityClose: number;
  income: CatTotal[];
  expense: CatTotal[];
  incomeTotal: number;
  expenseTotal: number;
  result: number;
  openingInPeriod: number;
  uncategorized: { income: number; expense: number };
}

export function statement(data: AppData, ledger: Ledger, period: Period): Statement {
  const transitLabel = (ref: string) => {
    const id = transitAccountId(ref);
    return id ? `Undervejs til ${data.accounts.find((a) => a.id === id)?.name ?? 'slettet konto'}` : 'Penge undervejs (ukendt modtager)';
  };
  const before = balancesAt(ledger, addDays(period.start, -1));
  const after = balancesAt(ledger, period.end);
  const accounts = new Map(data.accounts.map((a) => [a.id, a]));
  const refs = new Set([...before.keys(), ...after.keys()]);
  const listed = (a: Account) => (period.accountIds ? period.accountIds.includes(a.id) : !a.archived);
  for (const a of data.accounts) if (listed(a)) refs.add(`acc:${a.id}`);
  const bySign = (open: number, close: number, fallback: 'asset' | 'liability') =>
    close > 0 ? 'asset' : close < 0 ? 'liability' : open > 0 ? 'asset' : open < 0 ? 'liability' : fallback;

  const rows: BsRow[] = [];
  for (const ref of refs) {
    const open = before.get(ref) ?? 0;
    const close = after.get(ref) ?? 0;
    if (ref.startsWith('acc:')) {
      const a = accounts.get(ref.slice(4));
      // Poster uden for periodens liste vises kun, hvis de har en saldo – så intet forsvinder.
      if (!a || (!listed(a) && !open && !close)) continue;
      rows.push({ ref, label: a.name, kind: a.kind, typeId: a.typeId, side: bySign(open, close, a.side), open, close });
    } else {
      if (!open && !close) continue;
      const sideVal = close || open;
      rows.push({
        ref,
        label: isTransitRef(ref) ? transitLabel(ref) : ledger.cpLabels.get(ref) ?? ref.slice(3),
        kind: isTransitRef(ref) ? 'transit' : 'cp',
        side: bySign(open, close, sideVal >= 0 ? 'asset' : 'liability'),
        open,
        close,
      });
    }
  }
  // Poster i brugerens rækkefølge (rækkefølgen i data.accounts); automatiske rækker (undervejs, personer) til sidst.
  const order = new Map(data.accounts.map((a, i) => [`acc:${a.id}`, i]));
  const autoOrder = { transit: 0, cp: 1 } as Record<string, number>;
  rows.sort((a, b) => {
    const ia = order.get(a.ref), ib = order.get(b.ref);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return (autoOrder[a.kind] ?? 9) - (autoOrder[b.kind] ?? 9) || a.label.localeCompare(b.label, 'da');
  });

  const s = (side: 'asset' | 'liability', k: 'open' | 'close') =>
    rows.filter((r) => r.side === side).reduce((t, r) => t + r[k], 0);

  // Resultat
  const plSum = new Map<string, number>();
  let openingInPeriod = 0;
  for (const p of ledger.postings) {
    if (p.date < period.start || p.date > period.end || isBalanceRef(p.ref)) continue;
    if (p.ref === 'opening') openingInPeriod += p.amount;
    else plSum.set(p.ref, (plSum.get(p.ref) ?? 0) + p.amount);
  }
  const { income, expense } = categoryTotals(data.categories, plSum);
  const uncategorized = { income: plSum.get('uncat:income') ?? 0, expense: 0 - (plSum.get('uncat:expense') ?? 0) };
  const incomeTotal = income.reduce((t, c) => t + c.amount, 0) + uncategorized.income;
  const expenseTotal = expense.reduce((t, c) => t + c.amount, 0) + uncategorized.expense;

  return {
    period,
    rows,
    assetsOpen: s('asset', 'open'),
    assetsClose: s('asset', 'close'),
    liabOpen: -s('liability', 'open'),
    liabClose: -s('liability', 'close'),
    equityOpen: [...before.values()].reduce((t, v) => t + v, 0),
    equityClose: [...after.values()].reduce((t, v) => t + v, 0),
    income,
    expense,
    incomeTotal,
    expenseTotal,
    result: incomeTotal - expenseTotal,
    openingInPeriod,
    uncategorized,
  };
}

/**
 * Kategorier pr. slags. En "begge"-kategori (fx renter, afkast) placeres efter periodens nettobeløb:
 * positivt → indtægt, negativt → udgift.
 */
function categoryTotals(categories: Category[], plSum: Map<string, number>) {
  const tops = categories.filter((c) => !c.parentId || !categories.some((p) => p.id === c.parentId));
  const net = (t: Category) => descendants(categories, t.id).reduce((s, id) => s + (plSum.get(`cat:${id}`) ?? 0), 0);
  const kindOf = (t: Category): 'income' | 'expense' => (t.kind === 'both' ? (net(t) < 0 ? 'expense' : 'income') : t.kind);
  const node = (t: Category, sign: number, seen: Set<string>): CatTotal => {
    seen.add(t.id);
    const own = (plSum.get(`cat:${t.id}`) ?? 0) * sign;
    const children = childrenOf(categories, t.id).filter((c) => !seen.has(c.id)).map((c) => node(c, sign, seen));
    if (own && children.length) children.push({ id: `${t.id}#own`, name: '(uden underkategori)', amount: own, children: [], cats: [t.id], own: true });
    return { id: t.id, name: t.name, amount: own + children.reduce((s, c) => s + (c.own ? 0 : c.amount), 0), children, cats: descendants(categories, t.id) };
  };
  const build = (kind: 'income' | 'expense'): CatTotal[] =>
    tops
      .filter((t) => kindOf(t) === kind && (t.kind !== 'both' || net(t) !== 0))
      .map((t) => node(t, kind === 'income' ? 1 : -1, new Set()));
  // Kategorier der er slettet men stadig bruges, så intet forsvinder.
  const known = new Set(categories.map((c) => `cat:${c.id}`));
  const orphan = [...plSum.entries()].filter(([k]) => k.startsWith('cat:') && !known.has(k));
  const income = build('income');
  const expense = build('expense');
  for (const [k, v] of orphan) {
    const row = { id: k.slice(4), name: `Slettet kategori (${k.slice(4)})`, amount: Math.abs(v), children: [], cats: [k.slice(4)] };
    (v >= 0 ? income : expense).push(row);
  }
  return { income, expense };
}

export function accountOf(data: AppData, id?: string): Account | undefined {
  return id ? data.accounts.find((a) => a.id === id) : undefined;
}

// ---------------------------------------------------------------- Kilder til et beløb

export interface ValuationSource {
  valuationId: string;
  accountId: string;
  from: string;
  to: string;
  valueFrom: number;
  valueTo: number;
  /** Dine egne overførsler til/fra posten i intervallet (fortegnsbestemt som posten). */
  transfers: number;
}

/**
 * Posteringer på de angivne resultatkonti (fx cat:bo-renter-afkast) i perioden – grupperet så UI'et
 * kan vise, om beløbet stammer fra transaktioner, værdiændringer på aktiver/passiver eller manuelle poster.
 */
export function plSources(data: AppData, ledger: Ledger, period: Period, refs: Set<string>) {
  const ps = ledger.postings.filter((p) => refs.has(p.ref) && p.date >= period.start && p.date <= period.end);
  const tx = ps.filter((p) => p.txId);
  const val = ps.filter((p) => p.valuationId);
  const other = ps.filter((p) => !p.txId && !p.valuationId);
  const valuations: (ValuationSource & { amount: number })[] = [];
  for (const p of val) {
    const v = data.valuations.find((x) => x.id === p.valuationId);
    if (!v) continue;
    const prev = data.valuations.filter((x) => x.accountId === v.accountId && x.date < v.date).sort((a, b) => (a.date < b.date ? -1 : 1)).pop();
    const transfers = prev
      ? ledger.postings.filter((q) => q.ref === `acc:${v.accountId}` && q.txId && q.date > prev.date && q.date <= v.date).reduce((s, q) => s + q.amount, 0)
      : 0;
    valuations.push({ valuationId: v.id, accountId: v.accountId, from: prev?.date ?? '', to: v.date, valueFrom: prev?.value ?? 0, valueTo: v.value, transfers, amount: p.amount });
  }
  return { tx, valuations, other, total: ps.reduce((s, p) => s + p.amount, 0) };
}

/** Hvad en værdipost har givet i resultatet i perioden (afkast/renter m.m.), pr. kategori. */
export function valuationResultInPeriod(data: AppData, ledger: Ledger, period: Period, accountId: string) {
  const ids = new Set(data.valuations.filter((v) => v.accountId === accountId).map((v) => v.id));
  const m = new Map<string, number>();
  for (const p of ledger.postings) {
    if (!p.valuationId || !ids.has(p.valuationId) || isBalanceRef(p.ref) || p.ref === 'opening') continue;
    if (p.date < period.start || p.date > period.end) continue;
    m.set(p.ref, (m.get(p.ref) ?? 0) + p.amount);
  }
  return m;
}

/**
 * Hvad består en balancepost af i perioden: primo + bevægelser = ultimo.
 * Beløb er fortegnsbestemte som i hovedbogen (aktiv +, gæld −).
 */
export function balanceSources(ledger: Ledger, ref: string, period: Period) {
  const primo = balancesAt(ledger, addDays(period.start, -1)).get(ref) ?? 0;
  const moves = ledger.postings.filter((p) => p.ref === ref && p.date >= period.start && p.date <= period.end);
  const ultimo = balancesAt(ledger, period.end).get(ref) ?? 0;
  return { primo, moves, ultimo };
}
