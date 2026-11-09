import type { AppData, Category, TxType } from './types';

type Kind = Category['kind'];

/** Et neutralt eksempeltræ – indsættes kun, hvis brugeren selv vælger det. */
const tree: [string, Kind, string[]][] = [
  ['Løn', 'income', ['Fast løn', 'Overarbejde']],
  ['Freelance', 'income', []],
  ['Renter & afkast', 'both', []],
  ['Gaver modtaget', 'income', []],
  ['Diverse indtægter', 'income', []],
  ['Bolig', 'expense', ['Husleje', 'El & varme', 'Internet']],
  ['Dagligvarer', 'expense', []],
  ['Spisesteder', 'expense', []],
  ['Transport', 'expense', ['Brændstof', 'Offentlig transport']],
  ['Abonnementer', 'expense', ['Streaming', 'Mobil']],
  ['Hobby & sport', 'expense', []],
  ['Beklædning', 'expense', []],
  ['Sundhed', 'expense', []],
  ['Gaver givet', 'expense', []],
  ['Rejser', 'expense', []],
  ['Diverse udgifter', 'expense', []],
];

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const PREFIX: Record<Kind, string> = { income: 'in', expense: 'ex', both: 'bo' };

/** Unikt, læsbart id til en ny kategori (fx "ex-bolig--husleje"). */
export function newCategoryId(categories: Category[], kind: Kind, name: string, parentId?: string): string {
  const base = parentId ? `${parentId}--${slug(name)}` : `${PREFIX[kind]}-${slug(name) || 'kategori'}`;
  let id = base;
  for (let i = 2; categories.some((c) => c.id === id); i++) id = `${base}-${i}`;
  return id;
}

/** Eksempeltræet. */
export function defaultCategories(): Category[] {
  const out: Category[] = [];
  for (const [name, kind, subs] of tree) {
    const id = `${PREFIX[kind]}-${slug(name)}`;
    out.push({ id, name, kind });
    for (const s of subs) out.push({ id: `${id}--${slug(s)}`, name: s, kind, parentId: id });
  }
  return out;
}

/**
 * Nøgleordsgæt fra bankens kategorier til brugerens egne kategorier (fundet på navnet).
 * Bruges kun, når der ikke findes en eksplicit bankmapping – og vises altid som "forslag", der skal godkendes.
 */
export const BANK_KEYWORD_GUESSES: { re: RegExp; cat: RegExp; type: TxType; sign?: 'in' | 'out' }[] = [
  // Hele ord (\b), så fx "mobil" ikke rammer "MobilePay" og "sko" ikke rammer "skole".
  { re: /dagligvare|supermarked|købmand/, cat: /dagligvare|supermarked/i, type: 'expense' },
  { re: /restaurant|\bcaf[eé](?![a-zæøåé])|\bbar(er)?\b|værtshus|fast ?food|take ?away/, cat: /spisested|restaurant|caf[eé]/i, type: 'expense' },
  { re: /offentlig transport|\btog\b|\bbus\b|\btransport\b|rejsekort|brændstof|benzin/, cat: /transport/i, type: 'expense' },
  { re: /\btøj\b|beklædning|\bsko\b/, cat: /tøj|beklædning/i, type: 'expense' },
  { re: /\bmobil\b|mobilabonnement|\btelefon\b|telefoni|streaming|abonnement/, cat: /abonnement|mobil/i, type: 'expense' },
  { re: /\bhusleje\b|\bbolig\b|\bel\b|varme/, cat: /bolig|husleje/i, type: 'expense' },
  { re: /\brejse(r)?\b|\bferie\b|\bhotel(ler)?\b|\bfly\b/, cat: /rejse|ferie/i, type: 'expense' },
  { re: /fritid|\bsport\b|fitness|biograf|koncert|underholdning/, cat: /hobby|sport|fritid/i, type: 'expense' },
  { re: /læge|tandlæge|apotek|sundhed/, cat: /sundhed/i, type: 'expense' },
  { re: /\bgave(r)?\b/, cat: /gave/i, type: 'expense', sign: 'out' },
  { re: /\bgave(r)?\b/, cat: /gave/i, type: 'income', sign: 'in' },
  { re: /\brente(r)?\b|udbytte|afkast/, cat: /rente|afkast|udbytte/i, type: 'income', sign: 'in' },
  { re: /\bløn\b/, cat: /løn/i, type: 'income', sign: 'in' },
];

/** Find brugerens kategori til et nøgleordsgæt (samme slags eller "begge"; underkategori foretrækkes ikke). */
export function guessCategory(categories: Category[], g: (typeof BANK_KEYWORD_GUESSES)[number]): string | undefined {
  const kindOk = (c: Category) => c.kind === g.type || c.kind === 'both';
  return (categories.find((c) => !c.parentId && kindOk(c) && g.cat.test(c.name)) ?? categories.find((c) => kindOk(c) && g.cat.test(c.name)))?.id;
}

/** Helt tom start – ingen konti, typer, kategorier eller regler. Alt oprettes af brugeren. */
export function emptyData(): AppData {
  return {
    version: 1,
    settings: { bookStart: `${new Date().getFullYear() - 1}-12-31`, openingTransit: 0 },
    accounts: [],
    accountTypes: [],
    categories: [],
    rules: [],
    bankMap: {},
    txs: [],
    valuations: [],
    openItems: [],
    matches: [],
    imports: [],
    periods: [],
    slideNotes: {},
    importProfiles: {},
  };
}
