/**
 * Dagligt budget: faste udgifter og abonnementer – adskilt fra financial statementet.
 *
 * Abonnementer findes automatisk i de importerede transaktioner: samme modtager (normaliseret tekst) på samme konto,
 * trukket med fast rytme (måned, kvartal, halvår, år) og et nogenlunde fast beløb. Brugeren kan rette et fundet
 * abonnement, skjule det ("ikke et abonnement") eller selv tilføje et, der mangler. Kun brugerens rettelser gemmes –
 * resten regnes ud fra transaktionerne hver gang, så nye importer automatisk kommer med.
 */
import type { Resolved } from './classify';
import { isMobilePay, normalizeText } from './normalize';
import type { AppData, BudgetData, Cadence, Subscription, Tx } from './types';
import { dayDiff } from './util';

export const CADENCES: Cadence[] = ['monthly', 'quarterly', 'halfyear', 'yearly'];
export const CADENCE_MONTHS: Record<Cadence, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
export const CADENCE_LABEL: Record<Cadence, string> = { monthly: 'Hver måned', quarterly: 'Hvert kvartal', halfyear: 'Hvert halve år', yearly: 'Hvert år' };
/** "for …" efter et beløb, fx "1.235 kr. for det halve år". */
export const CADENCE_PER: Record<Cadence, string> = { monthly: 'om måneden', quarterly: 'for kvartalet', halfyear: 'for det halve år', yearly: 'for året' };

/** Dage mellem to træk med denne rytme. */
const CYCLE_DAYS: Record<Cadence, number> = { monthly: 30.44, quarterly: 91.31, halfyear: 182.62, yearly: 365.25 };
/**
 * Passer et interval til rytmen? Svarer til 1 (et normalt træk) eller 2–3 perioder (et træk mangler i bankdata,
 * eller en måned blev sprunget over). Weekender og helligdage flytter trækket et par dage.
 */
function cyclesOf(days: number, cadence: Cadence): number | undefined {
  for (let k = 1; k <= 3; k++) {
    const exp = CYCLE_DAYS[cadence] * k;
    if (Math.abs(days - exp) <= Math.min(25, Math.max(7, exp * 0.12))) return k;
  }
  return undefined;
}
const MIN_OCCURRENCES: Record<Cadence, number> = { monthly: 3, quarterly: 3, halfyear: 2, yearly: 2 };

/** Ord, der tyder på en regning, hvis beløb svinger (el, varme, forsikring …). */
const BILL_WORDS = /betalingsservice|\bbs\b|\bpbs\b|abonnement|medlemskab|kontingent|forsikring|\bel\b|varme|vand|fjernvarme|licens/;
/** Ord, der ikke hører med i navnet. */
const NAME_NOISE = /\b(betalingsservice|bs|pbs|nets|kortkøb|køb|abonnement|medlemskab|kontingent|aps|a\/s|as|betaling|faktura)\b/g;
/**
 * Ord, der ikke siger noget om modtageren: betalingsformidlere, domæner, selskabsformer og byer i udenlandske kortkøb.
 * "PAYPAL *SPOTIFY P3A1B2 STOCKHOLM" og "Spotify AB" er samme abonnement.
 */
const MERCHANT_NOISE = new Set([
  'betalingsservice', 'bs', 'pbs', 'nets', 'kortkøb', 'køb', 'abonnement', 'abonnem', 'medlemskab', 'kontingent', 'betaling', 'faktura',
  'paypal', 'pp', 'klarna', 'stripe', 'adyen', 'mobilepay', 'mobile', 'pay', 'mp', 'applepay', 'googlepay', 'dk', 'se', 'no', 'eu', 'com',
  'www', 'http', 'https', 'net', 'org', 'io', 'tv', 'ab', 'aps', 'as', 'a', 's', 'ltd', 'inc', 'gmbh', 'bv', 'oy', 'llc', 'sarl', 'sa',
  'limited', 'bill', 'billing', 'help', 'helppay', 'co', 'payment', 'subscription', 'recurring', 'til', 'fra', 'overf', 'reservation',
]);

/**
 * Modtageren i en posteringstekst – de to første betydende ord. Ord med tal (referencer, kortnumre) og støjord fjernes,
 * så små forskelle fra træk til træk ikke deler et abonnement op.
 */
export const merchantKey = (text: string) => merchantWords(text).slice(0, 2).join(' ');

function merchantWords(text: string): string[] {
  return text.toLowerCase().split(/[\s*/\\|,;:()[\]_.#-]+/)
    .filter((w) => w && !/\d/.test(w))
    .flatMap((w) => normalizeText(w).split(' '))
    .filter((w) => w.length > 1 && !MERCHANT_NOISE.has(w));
}

export interface DetectedSub {
  /** "<konto>|<normaliseret tekst>" – samme nøgle ved hver import. */
  key: string;
  name: string;
  accountId: string;
  /** Forventet beløb (positive øre): seneste beløb – eller gennemsnittet af de seneste, hvis det svinger. */
  amount: number;
  cadence: Cadence;
  /** En dato, hvor trækket kommer (typisk dag i måneden). */
  anchor: string;
  lastDate: string;
  txIds: string[];
  /** Beløbet svinger (fx el og varme). */
  variable: boolean;
  /** Ser ud til stadig at blive trukket (ud fra den nyeste import på kontoen). */
  active: boolean;
  categoryId?: string;
}

export type BudgetSource = 'detected' | 'edited' | 'manual';

/** Et abonnement, som det vises: fundet automatisk, rettet af brugeren eller tilføjet manuelt. */
export interface BudgetItem {
  id: string;
  key?: string;
  name: string;
  amount: number;
  cadence: Cadence;
  anchor: string;
  accountId?: string;
  source: BudgetSource;
  variable: boolean;
  active: boolean;
  /** Træk, der hører til abonnementet (bruges til "betalt"-flueben). */
  txIds: string[];
  lastDate?: string;
  categoryId?: string;
}

export const emptyBudget = (): BudgetData => ({ subscriptions: [], dismissed: [] });
export const budgetOf = (d: AppData): BudgetData => d.budget ?? emptyBudget();

// ------------------------------------------------------------------ datoer

const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1–12
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Datoen `months` måneder efter (før) anchor – på samme dag i måneden (eller sidste dag, hvis måneden er kortere). */
export function addMonthsKeepDay(anchor: string, months: number): string {
  const [y, m, d] = anchor.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysIn(ny, nm)))}`;
}

const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/** Alle træk mellem from og to (begge inkl.) for et abonnement med denne rytme. */
export function occurrencesBetween(anchor: string, cadence: Cadence, from: string, to: string): string[] {
  const step = CADENCE_MONTHS[cadence];
  const out: string[] = [];
  let k = Math.floor((monthIndex(from) - monthIndex(anchor)) / step) - 1;
  for (;; k++) {
    const d = addMonthsKeepDay(anchor, k * step);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** Næste træk på eller efter `from`. */
export const nextOccurrence = (anchor: string, cadence: Cadence, from: string) =>
  occurrencesBetween(anchor, cadence, from, addMonthsKeepDay(from, CADENCE_MONTHS[cadence] + 1))[0];

/** Beløbet omregnet til pr. måned. */
export const perMonth = (i: { amount: number; cadence: Cadence }) => Math.round(i.amount / CADENCE_MONTHS[i.cadence]);

// ------------------------------------------------------------------ navne

const titleCase = (s: string) => s.replace(/(^|\s)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** Pænt navn ud fra posteringsteksten: "Betalingsservice Lysværket" → "Lysværket". */
export function subName(text: string): string {
  const words = merchantWords(text).slice(0, 3);
  if (words.length) return titleCase(words.join(' '));
  const n = normalizeText(text);
  return titleCase(n.replace(NAME_NOISE, ' ').replace(/\s+/g, ' ').trim() || n || text.trim());
}

// ------------------------------------------------------------------ genkendelse

/** Udgifter, der kan være et abonnement: penge ud af en bankkonto, som ikke er en overførsel mellem egne konti. */
function candidates(data: AppData, resolved: Map<string, Resolved>): Tx[] {
  const bank = new Set(data.accounts.filter((a) => a.kind === 'bank').map((a) => a.id));
  return data.txs.filter((t) => {
    if (t.amount >= 0 || !bank.has(t.accountId)) return false;
    const r = resolved.get(t.id);
    return !r || !r.lines.every((l) => l.type === 'internal');
  });
}

export function detectSubscriptions(data: AppData, resolved: Map<string, Resolved>): DetectedSub[] {
  const latestOn = new Map<string, string>();
  for (const t of data.txs) if ((latestOn.get(t.accountId) ?? '') < t.date) latestOn.set(t.accountId, t.date);

  // Grupér efter konto + modtager.
  const groups = new Map<string, Tx[]>();
  for (const t of candidates(data, resolved)) {
    const m = merchantKey(t.text) || normalizeText(t.text);
    if (!m) continue;
    const key = `${t.accountId}|${m}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }

  const out: DetectedSub[] = [];
  for (const [key, all] of groups) {
    if (all.length < 2) continue;
    const txs = sortTxs(all);
    // Hele gruppen som ét abonnement (også hvis prisen er steget, eller det er en regning, der svinger) …
    const whole = evaluate(txs);
    if (whole) { out.push(build(key, txs, whole, latestOn, resolved)); continue; }
    // … ellers flere abonnementer hos samme modtager med hver sit beløb (fx to forsikringer eller to Apple-abonnementer).
    for (const c of amountClusters(txs)) {
      if (c.length < 2) continue;
      const r = evaluate(c);
      if (r) out.push(build(`${key}|${Math.round(median(c.map((t) => -t.amount)) / 100)}`, c, r, latestOn, resolved));
    }
  }
  return out.sort((a, b) => b.amount / CADENCE_MONTHS[b.cadence] - a.amount / CADENCE_MONTHS[a.cadence]);
}

const sortTxs = (txs: Tx[]) => [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));

/** Beløbsgrupper: træk inden for 15 % af hinanden. */
function amountClusters(txs: Tx[]): Tx[][] {
  const byAmount = [...txs].sort((a, b) => a.amount - b.amount);
  const out: Tx[][] = [];
  for (const t of byAmount) {
    const last = out[out.length - 1];
    if (last && Math.abs(t.amount - last[0].amount) <= Math.abs(last[0].amount) * 0.15) last.push(t);
    else out.push([t]);
  }
  return out.map(sortTxs);
}

interface Verdict { cadence: Cadence; variable: boolean; amount: number }

/** Er trækkene (sorteret efter dato) et abonnement? */
function evaluate(all: Tx[]): Verdict | undefined {
  // To træk inden for en uge (fx et nyt forsøg efter en afvist betaling) tæller som ét.
  const txs = all.filter((t, i) => i === 0 || dayDiff(all[i - 1].date, t.date) >= 7);
  if (txs.length < 2) return undefined;
  const gaps = txs.slice(1).map((t, i) => dayDiff(txs[i].date, t.date));

  // Rytme: den, flest intervaller passer præcist til. Mindst 75 % af intervallerne skal passe (evt. med et manglende træk),
  // og mindst halvdelen skal være præcis én periode.
  let best: { cadence: Cadence; exact: number; fit: number } | undefined;
  for (const c of CADENCES) {
    const ks = gaps.map((g) => cyclesOf(g, c));
    const exact = ks.filter((k) => k === 1).length;
    const fit = ks.filter((k) => k !== undefined).length;
    if (!best || exact > best.exact) best = { cadence: c, exact, fit };
  }
  if (!best || !best.exact || best.fit / gaps.length < 0.75 || best.exact / gaps.length < 0.5) return undefined;
  const cadence = best.cadence;
  if (txs.length < MIN_OCCURRENCES[cadence]) return undefined;

  // Beløb: fast (hvert træk inden for 15 % af det forrige – en prisstigning er fin) – eller en regning, der svinger inden for rimelighedens grænser.
  const amounts = txs.map((t) => -t.amount);
  const med = median(amounts);
  const steady = amounts.slice(1).filter((a, i) => Math.abs(a - amounts[i]) <= Math.max(a, amounts[i]) * 0.15).length;
  const near = amounts.filter((a) => Math.abs(a - med) <= med * 0.15).length;
  const fixed = near / amounts.length >= 0.75 || (amounts.length >= 3 && steady / (amounts.length - 1) >= 0.75);
  const lastText = txs[txs.length - 1].text;
  const billish = BILL_WORDS.test(normalizeText(lastText)) || BILL_WORDS.test(lastText.toLowerCase());
  const spread = Math.max(...amounts) / Math.max(1, Math.min(...amounts));
  if (!fixed && !(billish && spread <= 2.5)) return undefined;
  // Kun to træk: kræv næsten samme beløb, så tilfældige gentagelser ikke tæller.
  if (txs.length === 2 && Math.abs(amounts[0] - amounts[1]) > Math.max(amounts[0], amounts[1]) * 0.1) return undefined;
  // To MobilePay-betalinger til en person er sjældent et abonnement.
  if (txs.length === 2 && isMobilePay(txs[0].text)) return undefined;
  const recent = amounts.slice(-3);
  const variable = !fixed || recent.some((a) => Math.abs(a - median(recent)) > median(recent) * 0.03);
  const amount = !fixed ? Math.round(recent.reduce((s, a) => s + a, 0) / recent.length) : amounts[amounts.length - 1];
  return { cadence, variable, amount };
}

function build(key: string, txs: Tx[], v: Verdict, latestOn: Map<string, string>, resolved: Map<string, Resolved>): DetectedSub {
  // Den typiske dag i måneden (weekender flytter trækket et par dage).
  const last = txs[txs.length - 1];
  const day = Math.round(median(txs.slice(-6).map((t) => Number(t.date.slice(8, 10)))));
  const [ly, lm] = [Number(last.date.slice(0, 4)), Number(last.date.slice(5, 7))];
  const anchor = `${ly}-${pad(lm)}-${pad(Math.min(day, daysIn(ly, lm)))}`;
  const active = dayDiff(last.date, latestOn.get(last.accountId) ?? last.date) <= CYCLE_DAYS[v.cadence] * 1.5 + 7;
  const categoryId = resolved.get(last.id)?.lines.find((l) => l.categoryId)?.categoryId;
  return {
    key, name: subName(last.text), accountId: last.accountId, amount: v.amount, cadence: v.cadence, anchor, lastDate: last.date,
    txIds: txs.map((t) => t.id), variable: v.variable, active, ...(categoryId ? { categoryId } : {}),
  };
}

/** Transaktioner, der matcher et manuelt abonnement (tekst + konto). */
function manualTxIds(data: AppData, s: Subscription): string[] {
  const needle = normalizeText(s.match || s.name);
  if (!needle) return [];
  return data.txs.filter((t) => t.amount < 0 && (!s.accountId || t.accountId === s.accountId) && normalizeText(t.text).includes(needle)).map((t) => t.id);
}

/** Abonnementerne, som de vises: de fundne (minus skjulte, med brugerens rettelser) + de manuelt tilføjede. */
export function budgetItems(data: AppData, resolved: Map<string, Resolved>, detected = detectSubscriptions(data, resolved)): BudgetItem[] {
  const b = budgetOf(data);
  const dismissed = new Set(b.dismissed);
  const byKey = new Map(b.subscriptions.filter((s) => s.key).map((s) => [s.key!, s]));
  const items: BudgetItem[] = [];
  for (const d of detected) {
    if (dismissed.has(d.key)) continue;
    const o = byKey.get(d.key);
    items.push(o
      ? { id: o.id, key: d.key, name: o.name, amount: o.amount, cadence: o.cadence, anchor: o.anchor, accountId: o.accountId ?? d.accountId, source: 'edited', variable: false, active: true, txIds: d.txIds, lastDate: d.lastDate, categoryId: d.categoryId }
      : { id: `auto:${d.key}`, key: d.key, name: d.name, amount: d.amount, cadence: d.cadence, anchor: d.anchor, accountId: d.accountId, source: 'detected', variable: d.variable, active: d.active, txIds: d.txIds, lastDate: d.lastDate, categoryId: d.categoryId });
  }
  const found = new Set(detected.map((d) => d.key));
  for (const s of b.subscriptions) {
    // En rettelse til et fund, der ikke længere findes (fx efter sletning af en import), vises som et manuelt abonnement.
    if (s.key && found.has(s.key)) continue;
    if (s.key && dismissed.has(s.key)) continue;
    const txIds = manualTxIds(data, s);
    const lastDate = txIds.map((id) => data.txs.find((t) => t.id === id)!.date).sort().pop();
    items.push({ id: s.id, key: s.key, name: s.name, amount: s.amount, cadence: s.cadence, anchor: s.anchor, accountId: s.accountId, source: 'manual', variable: false, active: true, txIds, lastDate });
  }
  return items;
}

/** Trækket, der betalte et abonnement omkring en bestemt dato (±5 dage). */
export function paidTx(item: BudgetItem, date: string, txById: Map<string, Tx>): Tx | undefined {
  let best: Tx | undefined;
  for (const id of item.txIds) {
    const t = txById.get(id);
    if (!t) continue;
    const dd = Math.abs(dayDiff(date, t.date));
    if (dd <= 5 && (!best || dd < Math.abs(dayDiff(date, best.date)))) best = t;
  }
  return best;
}

export interface Occurrence { item: BudgetItem; date: string }

/** Alle træk fra aktive abonnementer i perioden, sorteret efter dato. */
export function occurrences(items: BudgetItem[], from: string, to: string): Occurrence[] {
  return items
    .filter((i) => i.active)
    .flatMap((item) => occurrencesBetween(item.anchor, item.cadence, from, to).map((date) => ({ item, date })))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.item.amount - a.item.amount));
}

// ------------------------------------------------------------------ rettelser (rene funktioner – kaldes via store.update)

const withBudget = (d: AppData, fn: (b: BudgetData) => BudgetData): AppData => ({ ...d, budget: fn(budgetOf(d)) });

/** Gem et abonnement (nyt eller rettet). Har det en nøgle, er det en rettelse til et fundet abonnement. */
export function saveSubscription(d: AppData, s: Subscription): AppData {
  return withBudget(d, (b) => ({
    ...b,
    subscriptions: [...b.subscriptions.filter((x) => x.id !== s.id && !(s.key && x.key === s.key)), s],
    dismissed: s.key ? b.dismissed.filter((k) => k !== s.key) : b.dismissed,
  }));
}

/** Fjern et abonnement: et fundet skjules (så det ikke dukker op igen), et manuelt slettes. */
export function removeSubscription(d: AppData, item: Pick<BudgetItem, 'id' | 'key'>): AppData {
  return withBudget(d, (b) => ({
    subscriptions: b.subscriptions.filter((x) => x.id !== item.id && !(item.key && x.key === item.key)),
    dismissed: item.key && !b.dismissed.includes(item.key) ? [...b.dismissed, item.key] : b.dismissed,
  }));
}

/** Fortryd en rettelse: vis det fundne abonnement, som Finstate selv fandt det. */
export function resetSubscription(d: AppData, key: string): AppData {
  return withBudget(d, (b) => ({ ...b, subscriptions: b.subscriptions.filter((x) => x.key !== key) }));
}

/** Vis et skjult abonnement igen. */
export function restoreSubscription(d: AppData, key: string): AppData {
  return withBudget(d, (b) => ({ ...b, dismissed: b.dismissed.filter((k) => k !== key) }));
}
