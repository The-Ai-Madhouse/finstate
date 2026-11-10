import type { Account, AccountTypeDef, AppData, Category, Period } from './types';
import { uid } from './util';

/**
 * Posttyper er brugerens egne labels (fx "Opsparing", "Lån", "Personer"). Der er ingen foruddefinerede typer,
 * og "Ingen type" er altid en mulighed. Hvordan saldoen findes, er et separat valg pr. post (Account.kind).
 */
export const NO_TYPE = 'Ingen type';

export function typeName(types: AccountTypeDef[], a: Pick<Account, 'typeId'>): string {
  return types.find((t) => t.id === a.typeId)?.name ?? NO_TYPE;
}

/** Hvordan postens saldo findes. */
export const KIND_LABEL: Record<Account['kind'], string> = {
  tracked: 'Følger overførsler',
  valuation: 'Tast selv',
  bank: 'Bankkonto (importerede transaktioner)',
};
export const KIND_HINT: Record<Account['kind'], string> = {
  tracked: 'Saldoen er summen af dine interne overførsler til/fra posten (fx "Jonas skylder mig").',
  valuation: 'Du skriver værdien pr. periodens start og slut. Ændringen ud over dine overførsler bliver afkast/renter.',
  bank: 'Saldoen kommer fra de transaktioner, du importerer.',
};

/** Foreslå kategori for uforklaret værdiændring ud fra brugerens egne kategorinavne. */
export function suggestCategory(categories: Category[], side: Account['side']): string | undefined {
  const re = side === 'asset' ? /afkast|udbytte|investering|kursgevinst|værdi/i : /rente/i;
  const ok = (c: Category) => re.test(c.name);
  return (
    categories.find((c) => c.kind === 'both' && ok(c)) ??
    categories.find((c) => c.kind === (side === 'asset' ? 'income' : 'expense') && ok(c)) ??
    categories.find(ok)
  )?.id;
}

/** Poster der bogføres direkte (ikke via "penge undervejs"): alt der ikke er en importeret bankkonto. */
export const isDirectTarget = (a?: Pick<Account, 'kind'>) => !!a && a.kind !== 'bank';

/** Ny brugertype (eller den eksisterende med samme navn). */
export function addAccountType(d: AppData, name: string): { data: AppData; id: string } {
  const n = name.trim();
  const existing = d.accountTypes.find((t) => t.name.trim().toLowerCase() === n.toLowerCase());
  if (existing) return { data: d, id: existing.id };
  const id = `type-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { data: { ...d, accountTypes: [...d.accountTypes, { id, name: n }] }, id };
}

/**
 * Hvilke perioder en ny post skal med i: den aktuelle og alle senere (så posten "følger med frem").
 * Perioder uden egen postliste (ældre data) viser alle poster og røres ikke.
 */
export function withAccountInPeriods(d: AppData, accountId: string, periodId?: string): AppData {
  const cur = d.periods.find((p) => p.id === periodId);
  if (!cur) return d;
  return {
    ...d,
    periods: d.periods.map((p) =>
      p.accountIds && p.start >= cur.start && !p.accountIds.includes(accountId) ? { ...p, accountIds: [...p.accountIds, accountId] } : p,
    ),
  };
}

/** Er posten med i periodens balance? */
export const inPeriod = (p: { accountIds?: string[] } | undefined, a: Pick<Account, 'id' | 'archived'>) =>
  p?.accountIds ? p.accountIds.includes(a.id) : !a.archived;

/** Postens kommentar i perioden. */
export const noteFor = (a: Pick<Account, 'notes'>, periodId?: string) => (periodId ? a.notes?.[periodId] : undefined);

/**
 * Ny periode: poster og deres kommentarer kopieres fra den forrige periode (den seneste, der starter før).
 * Uden en forrige periode kommer alle ikke-arkiverede poster med.
 */
export function withNewPeriod(d: AppData, p: Period): AppData {
  const sorted = [...d.periods].sort((a, b) => (a.start < b.start ? -1 : 1));
  const prev = sorted.filter((x) => x.start < p.start).pop() ?? sorted[sorted.length - 1];
  const accountIds = prev?.accountIds ?? d.accounts.filter((a) => !a.archived).map((a) => a.id);
  const accounts = prev
    ? d.accounts.map((a) => {
        const note = a.notes?.[prev.id];
        return note && !a.notes?.[p.id] ? { ...a, notes: { ...a.notes, [p.id]: note } } : a;
      })
    : d.accounts;
  return { ...d, accounts, periods: [...d.periods, { ...p, accountIds: p.accountIds ?? [...accountIds] }] };
}


/**
 * Skift hvordan postens saldo findes, uden at miste startværdien:
 * tast selv → følger overførsler: den første indtastede værdi bliver saldo ved bogføringsstart;
 * følger overførsler → tast selv: startsaldoen bliver værdien ved bogføringsstart.
 */
export function switchKind(d: AppData, accountId: string, kind: Account['kind']): AppData {
  const acc = d.accounts.find((a) => a.id === accountId);
  if (!acc || acc.kind === kind) return d;
  const { bookStart } = d.settings;
  let { openItems, valuations } = d;
  const start = openItems.find((o) => o.accountId === acc.id && !o.categoryId);
  const vals = valuations.filter((v) => v.accountId === acc.id).sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = vals.find((v) => v.date === bookStart) ?? vals[0];
  if (acc.kind === 'valuation' && first && !start) {
    openItems = [...openItems, { id: uid('oi'), date: bookStart, counterparty: acc.name, accountId: acc.id, amount: first.value }];
  }
  if (kind === 'valuation' && start) {
    openItems = openItems.filter((o) => o !== start);
    if (!vals.some((v) => v.date === bookStart)) valuations = [...valuations, { id: uid('val'), accountId: acc.id, date: bookStart, value: start.amount, adjustments: [] }];
  }
  return {
    ...d,
    openItems,
    valuations,
    accounts: d.accounts.map((a) => (a.id === acc.id ? { ...a, kind, defaultCategoryId: a.defaultCategoryId ?? (kind === 'valuation' ? suggestCategory(d.categories, a.side) : undefined) } : a)),
  };
}

/**
 * Sæt (eller fjern) værdien af en post, der tastes selv, på en dato.
 * Værdien angives med postens naturlige fortegn – gæld som positivt tal.
 */
export function withValuation(d: AppData, acc: Pick<Account, 'id' | 'side'>, date: string, shown: number | undefined): AppData {
  const ex = d.valuations.find((v) => v.accountId === acc.id && v.date === date);
  if (shown === undefined) return { ...d, valuations: d.valuations.filter((v) => v !== ex) };
  const value = acc.side === 'liability' ? -Math.abs(shown) : shown;
  if (ex) return { ...d, valuations: d.valuations.map((v) => (v === ex ? { ...v, value } : v)) };
  return { ...d, valuations: [...d.valuations, { id: uid('val'), accountId: acc.id, date, value, adjustments: [] }] };
}
