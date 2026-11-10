import { BANK_KEYWORD_GUESSES, guessCategory } from './defaults';
import { guessCounterparty, isMobilePay, normalizeText } from './normalize';
import type { Account, AppData, Classification, Rule, Split, Tx } from './types';
import { bankKey } from './types';
import { dayDiff } from './util';

export type Source =
  | 'split' // brugerens opdeling
  | 'manual' // brugerens valg
  | 'rule' // brugerens regel
  | 'alias' // tekst nævner en af mine egne konti
  | 'pair' // modsat beløb på en anden egen konto inden for få dage
  | 'bankmap' // min mapping af bankens kategori
  | 'bankguess' // nøgleordsgæt på bankens kategori
  | 'none';

export const SOURCE_LABEL: Record<Source, string> = {
  split: 'Opdelt',
  manual: 'Dit valg',
  rule: 'Regel',
  alias: 'Kontonavn',
  pair: 'Beløbsmatch',
  bankmap: 'Bankkategori',
  bankguess: 'Bankgæt',
  none: 'Ingen',
};

/** Kilder hvor jeg ikke selv har taget stilling – vises i "Til gennemsyn". */
export const NEEDS_REVIEW: ReadonlySet<Source> = new Set(['bankmap', 'bankguess', 'none']);

export interface Resolved {
  lines: Split[];
  source: Source;
  ruleId?: string;
  /** Intern overførsel parret med denne transaktion. */
  pairId?: string;
}

/** Klassifikationen for én linje (uden beløb). */
export const clsOfLine = (l: Split): Classification => {
  const { type, categoryId, counterparty, targetAccountId, transitRef } = l;
  return { type, categoryId, counterparty, targetAccountId, ...(transitRef ? { transitRef } : {}) };
};

export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) =>
    a.match !== b.match ? (a.match === 'exact' ? -1 : 1) : b.pattern.length - a.pattern.length,
  );
}

export function ruleMatches(r: Rule, tx: Tx, norm: string): boolean {
  if (!r.pattern.trim()) return false; // tom (ny) regel matcher intet
  if (r.accountId && r.accountId !== tx.accountId) return false;
  if (r.sign === 'in' && tx.amount <= 0) return false;
  if (r.sign === 'out' && tx.amount >= 0) return false;
  return r.match === 'exact' ? norm === r.pattern : norm.includes(r.pattern);
}

function completeCls(c: Classification, tx: Tx): Classification {
  if (c.type === 'outlay' && !c.counterparty) return { ...c, counterparty: guessCounterparty(tx.text) };
  return c;
}

const one = (tx: Tx, c: Classification): Split[] => [{ ...completeCls(c, tx), amount: tx.amount }];

/** Anvend en husket opdeling: faste beløb med transaktionens fortegn, resten til linjen uden beløb. */
export function splitLines(tx: Tx, splits: NonNullable<Rule['splits']>): Split[] {
  const sign = tx.amount < 0 ? -1 : 1;
  const fixed = splits.filter((s) => s.amount !== undefined).map((s) => ({ ...completeCls(s.cls, tx), amount: sign * s.amount! }));
  const restCls = splits.find((s) => s.amount === undefined)?.cls ?? splits[0].cls;
  const rest = tx.amount - fixed.reduce((t, l) => t + l.amount, 0);
  // Er transaktionen mindre end de faste beløb, giver opdelingen ikke mening – så hele beløbet til "resten".
  if (Math.sign(rest) === -sign) return one(tx, restCls);
  return [...(rest !== 0 ? [{ ...completeCls(restCls, tx), amount: rest }] : []), ...fixed];
}

interface Ctx {
  rules: Rule[];
  aliases: { accountId: string; alias: string }[];
  accounts: Map<string, Account>;
  bankMap: AppData['bankMap'];
  useBank?: boolean;
  /** Indbygget: kontonavn i teksten → intern. */
  autoAlias?: boolean;
  /** Indbygget: samme beløb ind/ud på to egne konti → intern. */
  autoPair?: boolean;
  categories?: AppData['categories'];
}

export function makeCtx(data: Pick<AppData, 'rules' | 'accounts' | 'bankMap'>): Ctx {
  return {
    rules: sortRules(data.rules),
    aliases: data.accounts.flatMap((a) =>
      // Personposter o.l. ('tracked') genkendes kun på tekster, brugeren selv har skrevet – ikke på navnet,
      // ellers ville fx alle "MobilePay Jonas Lind" stille blive til interne overførsler.
      (a.kind === 'tracked' ? a.aliases : [a.name, ...a.aliases]).map((x) => ({ accountId: a.id, alias: normalizeText(x) })).filter((x) => x.alias.length >= 3),
    ),
    accounts: new Map(data.accounts.map((a) => [a.id, a])),
    bankMap: data.bankMap,
  };
}

/** Trin 1: alt der kan afgøres for én transaktion alene, uden beløbsmatch. */
function stage1(tx: Tx, ctx: Ctx): Resolved | null {
  if (tx.splits?.length) return { lines: tx.splits.map((s) => ({ ...completeCls(s, tx), amount: s.amount })), source: 'split' };
  if (tx.manual) return { lines: one(tx, tx.manual), source: 'manual' };
  const norm = normalizeText(tx.text);
  const rule = ctx.rules.find((r) => ruleMatches(r, tx, norm));
  if (rule) return { lines: rule.splits?.length ? splitLines(tx, rule.splits) : one(tx, rule.then), source: 'rule', ruleId: rule.id };
  // Længste alias vinder ("min opsparing" før "opsparing").
  const hit = ctx.aliases
    .filter((a) => a.accountId !== tx.accountId && (` ${norm} `).includes(` ${a.alias} `))
    .sort((a, b) => b.alias.length - a.alias.length)[0];
  if (hit && ctx.autoAlias !== false) return { lines: one(tx, { type: 'internal', targetAccountId: hit.accountId }), source: 'alias' };
  return null;
}

/** Trin 3: svage forslag for det der stadig er uafklaret. */
function stage3(tx: Tx, ctx: Ctx): Resolved {
  const useBank = ctx.useBank !== false;
  const mapped = useBank ? ctx.bankMap[bankKey(tx.bankCategory, tx.bankSubcategory)] ?? ctx.bankMap[bankKey(tx.bankCategory, '')] : undefined;
  if (mapped && (tx.bankCategory || tx.bankSubcategory)) return { lines: one(tx, mapped), source: 'bankmap' };
  const bank = useBank ? `${tx.bankCategory ?? ''} ${tx.bankSubcategory ?? ''}`.toLowerCase().trim() : '';
  if (bank) {
    const sign = tx.amount > 0 ? 'in' : 'out';
    // Nøgleordsgæt bruges kun, hvis brugeren har en kategori med et passende navn.
    for (const g of BANK_KEYWORD_GUESSES) {
      if (!g.re.test(bank) || (g.sign && g.sign !== sign)) continue;
      const categoryId = ctx.categories && guessCategory(ctx.categories, g);
      if (categoryId) return { lines: one(tx, { type: g.type, categoryId }), source: 'bankguess' };
    }
  }
  return { lines: [{ type: tx.amount > 0 ? 'income' : 'expense', amount: tx.amount }], source: 'none' };
}

const TRANSFERISH = /\b(overf\w*|til|fra|opsparing|konto|budget)\b/i;
const USER_DECIDED: ReadonlySet<Source> = new Set(['split', 'manual', 'rule']);

/**
 * Resolverer alle transaktioner. Interne overførsler parres på tværs af konti:
 * først dine egne parringer, derefter automatisk (modsat beløb, ≤ 7 dages forskel, tætteste dato først).
 */
export function resolveAll(data: Pick<AppData, 'rules' | 'accounts' | 'bankMap' | 'txs'> & { settings?: AppData['settings']; categories?: AppData['categories'] }): Map<string, Resolved> {
  const ctx = makeCtx(data);
  ctx.useBank = data.settings?.useBankCategories !== false;
  ctx.autoAlias = data.settings?.autoAlias !== false;
  ctx.autoPair = data.settings?.autoPair !== false;
  ctx.categories = data.categories;
  // Regler er en avanceret funktion – uden den slået til ignoreres de.
  if (data.settings?.rulesEnabled === false) ctx.rules = [];
  const out = new Map<string, Resolved>();
  const s1 = new Map<string, Resolved | null>();
  for (const tx of data.txs) s1.set(tx.id, stage1(tx, ctx));

  // Kandidater til parring
  const isValuationTarget = (r: Resolved) => {
    const t = r.lines[0]?.targetAccountId;
    return !!t && !!ctx.accounts.get(t) && ctx.accounts.get(t)!.kind !== 'bank';
  };
  // Dine egne parringer (begge peger på hinanden).
  const txById = new Map(data.txs.map((t) => [t.id, t]));
  const explicit = new Map<string, string>();
  // En egen parring kræver, at begge er (delvist) interne – en rest kan være bogført på en kategori (fx et gebyr).
  const isInternal = (id: string) => s1.get(id)?.lines.some((l) => l.type === 'internal') ?? false;
  for (const t of data.txs) if (t.pairWith && txById.get(t.pairWith)?.pairWith === t.id && isInternal(t.id) && isInternal(t.pairWith)) explicit.set(t.id, t.pairWith);
  const cands = data.txs.filter((tx) => {
    if (explicit.has(tx.id) || tx.noAutoPair) return false;
    const r = s1.get(tx.id);
    // Bogført mod penge undervejs fra en tidligere periode: skal ikke parres med noget.
    if (r) return r.lines.length === 1 && r.lines[0].type === 'internal' && !r.lines[0].transitRef && !isValuationTarget(r);
    // Uafklarede transaktioner foreslås kun som interne, hvis beløbsmatch er slået til.
    return ctx.autoPair !== false && !isMobilePay(tx.text) && TRANSFERISH.test(tx.text);
  });
  const byAbs = new Map<number, Tx[]>();
  for (const t of cands) {
    const k = Math.abs(t.amount);
    if (!k) continue;
    (byAbs.get(k) ?? byAbs.set(k, []).get(k)!).push(t);
  }
  const pairs: { a: Tx; b: Tx; d: number }[] = [];
  for (const group of byAbs.values()) {
    const neg = group.filter((t) => t.amount < 0);
    const pos = group.filter((t) => t.amount > 0);
    for (const a of neg)
      for (const b of pos) {
        if (a.accountId === b.accountId) continue;
        const d = Math.abs(dayDiff(a.date, b.date));
        if (d > 7) continue;
        // Hvis mindst én af dem ikke er afgjort som intern, kræv tættere match.
        const weak = !s1.get(a.id) || !s1.get(b.id);
        if (weak && d > 4) continue;
        // Respektér eksplicit valgt modtagerkonto.
        const ta = s1.get(a.id)?.lines[0]?.targetAccountId;
        const tb = s1.get(b.id)?.lines[0]?.targetAccountId;
        if ((ta && ta !== b.accountId) || (tb && tb !== a.accountId)) continue;
        pairs.push({ a, b, d: d + (weak ? 0.5 : 0) });
      }
  }
  pairs.sort((x, y) => x.d - y.d);
  const paired = new Map<string, string>(explicit);
  for (const { a, b } of pairs) {
    if (paired.has(a.id) || paired.has(b.id)) continue;
    paired.set(a.id, b.id);
    paired.set(b.id, a.id);
  }

  const byId = new Map(data.txs.map((t) => [t.id, t]));
  for (const tx of data.txs) {
    const r1 = s1.get(tx.id);
    const pairId = paired.get(tx.id);
    if (r1) {
      out.set(tx.id, pairId ? { ...r1, pairId } : r1);
      continue;
    }
    if (pairId) {
      const other = byId.get(pairId)!;
      out.set(tx.id, { lines: one(tx, { type: 'internal', targetAccountId: other.accountId }), source: 'pair', pairId });
      continue;
    }
    out.set(tx.id, stage3(tx, ctx));
  }
  return out;
}

export function isUserDecided(r: Resolved) {
  return USER_DECIDED.has(r.source);
}

/** Opretter en regel ud fra en rettelse (normaliseret tekst + fortegn). */
export function ruleFromTx(tx: Tx, then: Classification, id: string): Rule {
  const c = { ...then };
  // Udlæg: modparten udledes af teksten – gem kun navnet, hvis brugeren har skrevet et andet.
  if (c.type === 'outlay' && (!c.counterparty || c.counterparty === guessCounterparty(tx.text))) delete c.counterparty;
  return {
    id,
    pattern: normalizeText(tx.text),
    match: 'exact',
    sign: tx.amount > 0 ? 'in' : 'out',
    then: c,
    createdAt: new Date().toISOString(),
  };
}
