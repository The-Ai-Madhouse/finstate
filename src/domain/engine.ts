import { coveredRange } from './imports';
import { isSettled, settleState } from './settle';
import { compareFor, elapsedEnd, inProgress, yearPeriod } from './periods';
import { migrateModel, migrateOutlays } from './migrate';
import { NEEDS_REVIEW, resolveAll, type Resolved } from './classify';
import { kr } from './format';
import { balancesAt, buildLedger, statement, type Ledger, type Statement } from './ledger';
import { bankBalanceAt } from './reconcile';
import type { AppData, Period, Tx } from './types';
import { addDays, dayDiff } from './util';
import type { NavTarget } from './nav-target';
import { hasUncategorized } from './txfilter';
import { transferInfo } from './transfers';

export interface Engine {
  data: AppData;
  resolved: Map<string, Resolved>;
  ledger: Ledger;
  txById: Map<string, Tx>;
  statement(p: Period): Statement;
}

export function buildEngine(data: AppData): Engine {
  const resolved = resolveAll(data);
  const ledger = buildLedger(data, resolved);
  const cache = new Map<string, Statement>();
  return {
    data,
    resolved,
    ledger,
    txById: new Map(data.txs.map((t) => [t.id, t])),
    statement(p) {
      const k = `${p.id}|${p.start}|${p.end}`;
      if (!cache.has(k)) cache.set(k, statement(data, ledger, p));
      return cache.get(k)!;
    },
  };
}

export const inPeriod = (t: { date: string }, p: Period) => t.date >= p.start && t.date <= p.end;

/** Hele året sammenlignes med dit valg eller forrige år (se compareFor for halvår). */
export function comparePeriod(data: AppData, p: Period): Period | undefined {
  return compareFor(data, p, 'year');
}

export type CheckLevel = 'ok' | 'info' | 'warn' | 'error';
export interface Check {
  id: string;
  level: CheckLevel;
  title: string;
  detail?: string;
  view?: string;
  /** Hvor "Gå til" fører hen – og hvad der fremhæves dér. */
  target?: NavTarget;
}

/** Kontrol med mål: view udledes af målet, og årsagen er kontrollens titel. */
const withTarget = (c: Omit<Check, 'view' | 'target'>, t: Omit<NavTarget, 'reason'>): Check => ({ ...c, view: t.view, target: { ...t, reason: c.title } });

/** Kontroller for perioden – i samme rækkefølge som arbejdsgangen. */
export function periodChecks(e: Engine, p: Period): Check[] {
  const { data, resolved, ledger } = e;
  const out: Check[] = [];
  const st = e.statement(p);
  const txs = data.txs.filter((t) => inPeriod(t, p) && t.date > data.settings.bookStart);

  if (p.start <= data.settings.bookStart) {
    out.push(withTarget({ id: 'bookstart', level: 'warn', title: 'Perioden starter før bogføringsstart', detail: `Bogføringsstart er ${data.settings.bookStart}. Transaktioner før den dato tæller ikke – ret den i Åbningsbalance & bogføringsstart.` }, { view: 'balance', key: 'balance:bookstart' }));
  }

  const listed = (a: { id: string; archived?: boolean }) => (p.accountIds ? p.accountIds.includes(a.id) : !a.archived);
  // 1. Import & saldo
  if (!data.accounts.some((a) => a.kind === 'bank' && listed(a))) {
    out.push(withTarget({ id: 'no-bank', level: 'warn', title: 'Ingen bankdata importeret endnu', detail: 'Importér en CSV-fil for hver bankkonto, der dækker perioden.' }, { view: 'import', key: 'import:drop' }));
  }
  for (const acc of data.accounts.filter((a) => a.kind === 'bank' && listed(a))) {
    const chain = ledger.chains.get(acc.id)!;
    const accTx = chain.ordered;
    const inP = accTx.filter((t) => inPeriod(t, p));
    if (!accTx.length) {
      out.push(withTarget({ id: `import-${acc.id}`, level: 'warn', title: `${acc.name}: ingen transaktioner importeret` }, { view: 'import', key: `import:cover:${acc.id}` }));
      continue;
    }
    // Seneste dato med data: sidste transaktion – eller senere, hvis en fil er angivet at dække længere.
    const last = coveredRange(data, acc.id).last ?? accTx[accTx.length - 1].date;
    // Et igangværende år skal kun have data frem til i dag.
    const until = elapsedEnd(p);
    if (last < until && dayDiff(last, until) > 14 && !p.coverageOk?.includes(acc.id)) {
      out.push(withTarget({ id: `cover-${acc.id}`, level: 'info', title: `${acc.name}: sidste transaktion er ${last}`, detail: 'Importér evt. en nyere eksport, hvis kontoen har haft bevægelser siden.' }, { view: 'import', key: `import:cover:${acc.id}` }));
    }
    const breaks = chain.breaks.filter((b) => inPeriod(b, p));
    if (breaks.length) {
      out.push(withTarget({ id: `chain-${acc.id}`, level: 'error', title: `${acc.name}: saldokæden brydes ${breaks.length} gang(e)`, detail: breaks.slice(0, 3).map((b) => `${b.date}: ${kr(b.diff)} mangler/er for meget`).join(' · ') }, { view: 'import', key: `import:summary:${acc.id}` }));
    }
    const bankEnd = bankBalanceAt(accTx, p.end);
    const ledgerEnd = balancesAt(ledger, p.end).get(`acc:${acc.id}`) ?? 0;
    if (bankEnd !== undefined && bankEnd !== ledgerEnd) {
      out.push(withTarget({ id: `bal-${acc.id}`, level: 'error', title: `${acc.name}: bogført saldo ${kr(ledgerEnd)} ≠ bankens saldo ${kr(bankEnd)}`, detail: 'Tjek kontoens åbningssaldo under Detaljer i balancen – eller om der mangler transaktioner.' }, { view: 'balance', key: `post:${acc.id}:opening`, ctx: { open: acc.id } }));
    } else if (inP.length) {
      out.push({ id: `bal-${acc.id}`, level: 'ok', title: `${acc.name}: ${inP.length} transaktioner, saldo afstemt (${kr(ledgerEnd)})` });
    }
  }

  // 2. Kategorisering
  const review = txs.filter((t) => NEEDS_REVIEW.has(resolved.get(t.id)!.source));
  out.push(
    review.length
      ? withTarget({ id: 'review', level: 'warn', title: `${review.length} transaktioner mangler din afgørelse`, detail: 'Forslag fra bankens kategorier og transaktioner uden forslag skal afgøres af dig.' }, { view: 'ledger', key: 'ledger:pending', first: true, ctx: { ledgerFilter: {} } })
      : { id: 'review', level: 'ok', title: 'Alle transaktioner er kategoriseret af dig' },
  );
  if (st.uncategorized.income || st.uncategorized.expense) {
    // To kilder: transaktioner uden kategori – og værdiposter, hvis uforklarede ændring ikke har en kategori.
    const uncatTx = txs.filter((t) => hasUncategorized(resolved.get(t.id)!));
    const valIds = new Set(ledger.postings.filter((x) => x.ref.startsWith('uncat:') && x.valuationId && x.amount && x.date >= p.start && x.date <= p.end).map((x) => x.valuationId!));
    const uncatPosts = data.accounts.filter((a) => a.kind === 'valuation' && data.valuations.some((v) => v.accountId === a.id && valIds.has(v.id)));
    const detail = `Indtægter ${kr(st.uncategorized.income)}, udgifter ${kr(st.uncategorized.expense)}`;
    if (uncatTx.length) out.push(withTarget({ id: 'uncat', level: 'warn', title: `${uncatTx.length} ${uncatTx.length === 1 ? 'transaktion' : 'transaktioner'} uden kategori`, detail }, { view: 'ledger', key: 'ledger:uncat', first: true, ctx: { ledgerFilter: { status: 'uncat' } } }));
    for (const a of uncatPosts) out.push(withTarget({ id: `uncat-post-${a.id}`, level: 'warn', title: `${a.name}: den uforklarede ændring har ingen kategori`, detail: 'Vælg, hvad den bogføres som (fx afkast eller renter).' }, { view: 'balance', key: `post:${a.id}:category`, ctx: { open: a.id } }));
    if (!uncatTx.length && !uncatPosts.length) out.push({ id: 'uncat', level: 'warn', title: 'Der er beløb uden kategori', detail, view: 'ledger' });
  }

  // 3. Interne overførsler
  // Samme inddeling som listen på Overførsler (så antallet og "Gå til" passer med det, man ser dér).
  const internalUnpaired = txs.filter((t) => transferInfo(data, resolved, e.txById, t, p)?.kind === 'missing');
  const transit = st.rows.filter((r) => r.kind === 'transit').reduce((s, r) => s + r.close, 0);
  if (internalUnpaired.length) {
    out.push(withTarget({ id: 'transit', level: transit ? 'info' : 'warn', title: `${internalUnpaired.length} interne overførsler uden modpost`, detail: transit ? `${kr(transit)} står som "Penge undervejs" ved periodens slutning – typisk overførsler, der først lander i næste periode.` : 'Uparrede overførsler går op i nul, men tjek dem.' }, { view: 'transfers', key: 'xfer:missing', first: true, ctx: { transfers: { status: 'missing' } } }));
  } else out.push({ id: 'transit', level: 'ok', title: 'Alle interne overførsler er parret' });

  // 4. Udlæg
  const open = st.rows.filter((r) => r.kind === 'cp' && r.close);
  if (open.length) {
    const recv = open.filter((r) => r.close > 0).reduce((s, r) => s + r.close, 0);
    const owe = -open.filter((r) => r.close < 0).reduce((s, r) => s + r.close, 0);
    out.push(withTarget({ id: 'cp', level: 'info', title: `${open.length} personer med åbne udlæg`, detail: `Tilgodehavende ${kr(recv)} · gæld ${kr(owe)}. Tjek at de er reelle – ellers er det en udgift/indtægt.` }, { view: 'balance', key: 'balance:cp' }));
  }

  // 4b. Afstemning: de poster, du afstemmer i perioden, skal være afklaret (parret, afskrevet – eller taget med til næste periode)
  for (const a of data.accounts.filter((x) => isSettled(p, x))) {
    const ss = settleState(data, ledger, a.id, p);
    const n = ss.pending.length + ss.bad.length;
    if (n) out.push(withTarget({ id: `settle-${a.id}`, level: 'warn', title: `${a.name}: ${n} ${n === 1 ? 'uafklaret' : 'uafklarede'} i afstemningen`, detail: 'Afskriv det, der ikke går op – eller lad det stå som aktiv/passiv.' }, { view: 'transfers', key: `settle:post:${a.id}`, ctx: { settle: { postId: a.id } } }));
    else if (ss.items.length) out.push({ id: `settle-${a.id}`, level: 'ok', title: `${a.name}: afstemt${ss.carriedSum ? ` – ${kr(Math.abs(ss.carriedSum))} står som ${ss.carriedSum > 0 ? 'aktiv' : 'passiv'}` : ''}` });
  }

  // 5. Værdier
  for (const acc of data.accounts.filter((a) => a.kind === 'valuation' && listed(a))) {
    const has = data.valuations.some((v) => v.accountId === acc.id && v.date === p.end);
    if (!has) out.push(inProgress(p)
      ? withTarget({ id: `val-${acc.id}`, level: 'info', title: `${acc.name}: angiv værdi pr. ${p.end}, når året er slut` }, { view: 'balance', key: `post:${acc.id}:ultimo` })
      : withTarget({ id: `val-${acc.id}`, level: 'warn', title: `${acc.name}: angiv værdi pr. ${p.end}` }, { view: 'balance', key: `post:${acc.id}:ultimo` }));
  }
  for (const w of ledger.warnings) {
    // Værdien pr. bogføringsstart skrives i primo-feltet, når bogføringsstart er dagen før periodens start.
    const key = w.kind === 'no-value' ? `post:${w.accountId}:ultimo` : data.settings.bookStart === addDays(p.start, -1) ? `post:${w.accountId}:primo` : `post:${w.accountId}`;
    out.push(withTarget({ id: `w-${w.kind}-${w.accountId}`, level: 'warn', title: w.text }, { view: 'balance', key, ctx: { open: w.accountId } }));
  }

  // 6. Går det op?
  const diff = st.equityClose - st.equityOpen - st.result - st.openingInPeriod;
  out.push(
    diff === 0
      ? { id: 'balance', level: 'ok', title: `Regnskabet går op: Δ egenkapital ${kr(st.equityClose - st.equityOpen)} = resultat${st.openingInPeriod ? ' + åbningsposter' : ''}` }
      : { id: 'balance', level: 'error', title: `Regnskabet går ikke op (difference ${kr(diff)})`, detail: 'Dette burde ikke kunne ske – rapportér gerne.' },
  );
  return out;
}

export function suggestPeriods(data: AppData): Period[] {
  const years = new Set(data.txs.map((t) => Number(t.date.slice(0, 4))));
  if (!years.size) years.add(new Date().getFullYear());
  const out: Period[] = [];
  for (const y of [...years].sort()) out.push(yearPeriod(y));
  return out.filter((p) => !data.periods.some((x) => x.id === p.id));
}

export const dayBefore = (iso: string) => addDays(iso, -1);

/** Dagen før den første måned med data, fx første transaktion 2025-01-03 → 2024-12-31. */
export function autoBookStart(data: Pick<AppData, 'txs'> & { periods?: Period[] }): string | undefined {
  const candidates: string[] = [];
  if (data.txs.length) {
    let min = data.txs[0].date;
    for (const t of data.txs) if (t.date < min) min = t.date;
    candidates.push(addDays(`${min.slice(0, 7)}-01`, -1));
  }
  // Starter man et financial statement før importen, skal bogføringen også dække det.
  for (const p of data.periods ?? []) candidates.push(addDays(p.start, -1));
  return candidates.sort()[0];
}

/** Normalisering ved indlæsning: migrér gamle udlæg og lad bogføringsstart følge data. */
export function withAutoBookStart(input: AppData): AppData {
  const d = migrateModel(migrateOutlays(input));
  if (d.settings.bookStartSet) return d;
  const auto = autoBookStart(d);
  return auto && auto !== d.settings.bookStart ? { ...d, settings: { ...d.settings, bookStart: auto } } : d;
}

export interface Coverage {
  accountId: string;
  name: string;
  first?: string;
  last?: string;
  /** Data starter senest ~2 uger inde i perioden (eller før), så primo kan bestemmes. */
  coversStart: boolean;
  /** Data når frem til ~2 uger før periodens slutning (eller i dag, hvis perioden ikke er slut). */
  coversEnd: boolean;
  /** Brugeren har accepteret, at data ikke dækker hele perioden – ingen advarsel. */
  accepted: boolean;
}

/** Dækker de importerede bankdata perioden – for hver bankkonto? */
export function importCoverage(data: AppData, p: Period, today = new Date().toISOString().slice(0, 10)): Coverage[] {
  const effectiveEnd = p.end < today ? p.end : today;
  return data.accounts
    // Samme konti som periodens kontroller: periodens liste – ellers alle ikke-arkiverede.
    .filter((a) => a.kind === 'bank' && (p.accountIds ? p.accountIds.includes(a.id) : !a.archived))
    .map((a) => {
      const { first, last } = coveredRange(data, a.id);
      return {
        accountId: a.id,
        name: a.name,
        first,
        last,
        coversStart: !!first && !!last && first <= addDays(p.start, 14) && last >= addDays(p.start, -1),
        coversEnd: !!last && last >= addDays(effectiveEnd, -14),
        accepted: !!p.coverageOk?.includes(a.id),
      };
    });
}
