/**
 * Typen "Udlæg" er afskaffet: et udlæg er blot en intern overførsel til en post på balancen
 * (fx "Jonas skylder mig" eller "Jeg skylder Ida"). Denne migrering flytter ældre data over:
 *  - én post pr. person (kind 'tracked', saldoen følger overførslerne)
 *  - dine valg/opdelinger/regler med udlæg → intern overførsel til personens post
 *  - åbne poster (startsaldi og afskrivninger) peger på personens post
 * Den er idempotent: uden udlæg i data returneres data uændret.
 */
import { resolveAll } from './classify';
import type { Account, AppData, Classification, Period, Split } from './types';
import { uid } from './util';

const isOutlay = (c?: { type: string }) => c?.type === 'outlay';

export function hasLegacyOutlays(d: AppData): boolean {
  return (
    d.txs.some((t) => isOutlay(t.manual) || t.splits?.some(isOutlay)) ||
    d.rules.some((r) => isOutlay(r.then) || r.splits?.some((s) => isOutlay(s.cls))) ||
    Object.values(d.bankMap).some(isOutlay) ||
    d.openItems.some((o) => !o.accountId)
  );
}

export function migrateOutlays(d: AppData): AppData {
  if (!hasLegacyOutlays(d)) return d;
  const resolved = resolveAll(d);
  const userDecided = new Set(['manual', 'rule', 'split']);

  // 1) Personer og deres nettosaldo (+ = de skylder mig).
  const people = new Map<string, { name: string; bal: number }>();
  const touch = (name: string | undefined, amount: number) => {
    const n = (name || 'Ukendt').trim();
    const k = n.toLowerCase();
    const p = people.get(k) ?? people.set(k, { name: n, bal: 0 }).get(k)!;
    p.bal += amount;
  };
  for (const t of d.txs) {
    const r = resolved.get(t.id);
    if (!r || !userDecided.has(r.source)) continue;
    for (const l of r.lines) if (l.type === 'outlay') touch(l.counterparty, -l.amount);
  }
  for (const o of d.openItems) if (!o.accountId) touch(o.counterparty, o.amount);

  // 2) En post pr. person (genbrug en eksisterende post med samme navn).
  const accounts: Account[] = [...d.accounts];
  const idFor = new Map<string, string>();
  for (const [k, p] of people) {
    const existing = accounts.find((a) => a.name.trim().toLowerCase() === k && a.kind !== 'bank');
    if (existing) { idFor.set(k, existing.id); continue; }
    const asset = p.bal >= 0;
    const acc: Account = { id: uid('acc'), name: p.name, kind: 'tracked', side: asset ? 'asset' : 'liability', aliases: [] };
    accounts.push(acc);
    idFor.set(k, acc.id);
  }
  const toInternal = (l: Classification): Classification =>
    l.type === 'outlay' ? { type: 'internal', targetAccountId: idFor.get((l.counterparty || 'Ukendt').trim().toLowerCase()) } : l;

  // 3) Transaktioner: udlæg (fra dit valg, din regel eller opdeling) → intern til personens post.
  const txs = d.txs.map((t) => {
    const r = resolved.get(t.id);
    if (!r || !userDecided.has(r.source) || !r.lines.some((l) => l.type === 'outlay')) return t;
    const n = { ...t };
    if (r.lines.length === 1) {
      const { amount: _a, ...cls } = r.lines[0];
      void _a;
      n.manual = toInternal(cls);
      delete n.splits;
    } else {
      n.splits = r.lines.map((l): Split => ({ ...toInternal(l), amount: l.amount, ...(l.note ? { note: l.note } : {}) }));
      delete n.manual;
    }
    return n;
  });

  // 4) Regler og bankmapping med udlæg fjernes – de berørte transaktioner har nu deres eget valg.
  const rules = d.rules.filter((r) => !isOutlay(r.then) && !r.splits?.some((s) => isOutlay(s.cls)));
  const bankMap = Object.fromEntries(Object.entries(d.bankMap).filter(([, m]) => !isOutlay(m)));

  // 5) Åbne poster peger på personens post.
  const openItems = d.openItems.map((o) => (o.accountId ? o : { ...o, accountId: idFor.get(o.counterparty.trim().toLowerCase()) }));

  return { ...d, accounts, txs, rules, bankMap, openItems };
}

/** Labels for de tidligere foruddefinerede typer – bliver til brugerens egne typer ved migrering. */
const LEGACY_TYPE_LABEL: Record<string, string | undefined> = {
  liquid: 'Likvide midler', bank: 'Likvide midler', 'broker-cash': 'Likvide midler', cash: 'Likvide midler',
  securities: 'Værdipapirer', investment: 'Værdipapirer', pension: 'Værdipapirer',
  receivable: 'Tilgodehavender', deposit: 'Tilgodehavender',
  loan: 'Lån', credit: 'Lån',
  // "Andet" var reelt ingen type.
  'other-asset': undefined, payable: undefined, property: undefined, 'person-debt': undefined, tax: undefined, 'other-liability': undefined,
};

/**
 * Datamodel v2 (idempotent):
 *  - foruddefinerede typer (subtype) → brugerens egne typer (accountTypes)
 *  - kommentar pr. post → kommentar pr. periode (kopieret til alle eksisterende perioder)
 *  - perioder får deres egen postliste (de ikke-arkiverede poster)
 *  - regler bliver en avanceret funktion: er der regler, gemmes deres valg som dine egne valg på
 *    transaktionerne, og reglerne slås fra (de slettes ikke og kan slås til igen i Indstillinger).
 */
export function migrateModel(input: AppData): AppData {
  let d = migratePeriods(input);
  if (!d.accountTypes || d.accounts.some((a) => a.subtype !== undefined)) {
    const types: { id: string; name: string }[] = [...(d.accountTypes ?? [])];
    const idOf = (name: string) => {
      let t = types.find((x) => x.name === name);
      if (!t) types.push((t = { id: uid('type'), name }));
      return t.id;
    };
    const accounts = d.accounts.map((a) => {
      const { subtype, ...rest } = a;
      // Kendte ældre id'er får deres label; andre lån-varianter bliver "Lån"; resten får ingen type.
      const label = !subtype ? undefined : subtype in LEGACY_TYPE_LABEL ? LEGACY_TYPE_LABEL[subtype] : /loan|credit/.test(subtype) ? 'Lån' : undefined;
      return label ? { ...rest, typeId: idOf(label) } : rest;
    });
    d = { ...d, accounts, accountTypes: types };
  }
  if (d.accounts.some((a) => a.note !== undefined) && d.periods.length) {
    d = {
      ...d,
      accounts: d.accounts.map((a) => {
        if (a.note === undefined) return a;
        const { note, ...rest } = a;
        return { ...rest, notes: { ...Object.fromEntries(d.periods.map((p) => [p.id, note])), ...a.notes } };
      }),
    };
  }
  if (d.periods.some((p) => !p.accountIds)) {
    const ids = d.accounts.filter((a) => !a.archived).map((a) => a.id);
    d = { ...d, periods: d.periods.map((p) => (p.accountIds ? p : { ...p, accountIds: ids })) };
  }
  if (d.settings.rulesEnabled === undefined) {
    let txs = d.txs;
    if (d.rules.length) {
      const resolved = resolveAll(d);
      txs = d.txs.map((t) => {
        const r = resolved.get(t.id);
        if (!r || r.source !== 'rule') return t;
        if (r.lines.length === 1) {
          const { amount: _a, ...cls } = r.lines[0];
          void _a;
          return { ...t, manual: cls };
        }
        return { ...t, splits: r.lines };
      });
    }
    d = { ...d, txs, settings: { ...d.settings, rulesEnabled: false } };
  }
  return d;
}

type Half = 'h1' | 'h2';
function halfOf(p: Period): { year: string; half: Half } | undefined {
  const year = p.start.slice(0, 4);
  if (p.start === `${year}-01-01` && p.end === `${year}-06-30`) return { year, half: 'h1' };
  if (p.start === `${year}-07-01` && p.end === `${year}-12-31`) return { year, half: 'h2' };
  return undefined;
}

/**
 * Financial statements er nu årlige. Halvårsperioder (H1/H2) lægges sammen til året:
 *  - findes året allerede, bruges det; ellers bliver det seneste halvår til året (dets id bevares)
 *  - poster, accepteret dækning, kommentarer og slideshow-tekster følger med
 *  - fandtes kun ét halvår, viser Regnskab fortsat kun det halvår (kan ændres)
 * Idempotent: uden halvårsperioder returneres data uændret.
 */
export function migratePeriods(d: AppData): AppData {
  const halves = d.periods.filter((p) => halfOf(p));
  if (!halves.length) return d;
  const byYear = new Map<string, Period[]>();
  for (const h of halves) {
    const y = halfOf(h)!.year;
    byYear.set(y, [...(byYear.get(y) ?? []), h]);
  }
  /** gammelt id → nyt id og hvilket halvår det var */
  const moved = new Map<string, { id: string; half: Half }>();
  let periods = d.periods.filter((p) => !halfOf(p));
  for (const [year, hs] of byYear) {
    hs.sort((a, b) => (a.start < b.start ? 1 : -1)); // 2. halvår først
    const full = periods.find((p) => p.start === `${year}-01-01` && p.end === `${year}-12-31`);
    const keep = full ?? hs[0];
    const all = full ? [full, ...hs] : hs;
    const union = (pick: (p: Period) => string[] | undefined) => {
      const lists = all.map(pick).filter((x): x is string[] => !!x);
      return lists.length ? [...new Set(lists.flat())] : undefined;
    };
    const merged: Period = {
      ...keep,
      start: `${year}-01-01`,
      end: `${year}-12-31`,
      name: full ? full.name : /^\s*\d{4}\s*H[12]\s*$/i.test(keep.name) ? year : keep.name.replace(/\s*H[12]\b/i, '').trim() || year,
      accountIds: union((p) => p.accountIds),
      coverageOk: union((p) => p.coverageOk),
      // Bekræftelsen gælder balancen pr. ultimo – den holder kun, hvis ultimo er det samme.
      balanceConfirmed: full ? full.balanceConfirmed : halfOf(keep)!.half === 'h2' ? keep.balanceConfirmed : undefined,
      show: full ? full.show : hs.length === 1 ? halfOf(keep)!.half : undefined,
    };
    if (!merged.coverageOk) delete merged.coverageOk;
    if (merged.balanceConfirmed === undefined) delete merged.balanceConfirmed;
    if (merged.show === undefined) delete merged.show;
    for (const h of hs) if (h.id !== merged.id) moved.set(h.id, { id: merged.id, half: halfOf(h)!.half });
    periods = [...periods.filter((p) => p !== full), merged];
  }
  // Rækkefølge: 2. halvår før 1. halvår, så den seneste kommentar vinder.
  const order = [...moved.entries()].sort((a, b) => (a[1].half === b[1].half ? 0 : a[1].half === 'h2' ? -1 : 1));
  const remapRecord = <T,>(rec: Record<string, T> | undefined, keepIds: Set<string>) => {
    if (!rec) return rec;
    const out = { ...rec };
    for (const [old, to] of order) {
      if (!(old in out)) continue;
      if (!(to.id in out) || !keepIds.has(to.id)) out[to.id] = out[old];
      keepIds.add(to.id);
      delete out[old];
    }
    return out;
  };
  const halfIds = new Set(halves.map((h) => h.id));
  return {
    ...d,
    periods: periods.map((p) => {
      if (!p.compareToId) return p;
      const m = moved.get(p.compareToId);
      // Sammenligning med et halvår bliver til "året#halvår"; med sig selv giver den ikke mening.
      const halfSelf = halfIds.has(p.compareToId) && !m ? halfOf(d.periods.find((x) => x.id === p.compareToId)!) : undefined;
      const key = m ? `${m.id}#${m.half}` : halfSelf ? `${p.compareToId}#${halfSelf.half}` : p.compareToId;
      return { ...p, compareToId: key === p.id ? undefined : key };
    }),
    accounts: d.accounts.map((a) => (a.notes && [...moved.keys()].some((k) => k in a.notes!)
      ? { ...a, notes: remapRecord(a.notes, new Set(Object.keys(a.notes).filter((k) => !moved.has(k)))) }
      : a)),
    slideNotes: halfSlideNotes(d.slideNotes, halves, moved),
  };
}

/** Slideshow-tekster for et halvår gemmes under "<år-id>#h1"/"#h2" (de hører til det halvårlige slideshow). */
function halfSlideNotes(rec: AppData['slideNotes'], halves: Period[], moved: Map<string, { id: string }>): AppData['slideNotes'] {
  const out = { ...rec };
  for (const h of halves) {
    if (!(h.id in rec)) continue;
    const key = `${moved.get(h.id)?.id ?? h.id}#${halfOf(h)!.half}`;
    delete out[h.id];
    out[key] = { ...rec[h.id], ...out[key] };
  }
  return out;
}
