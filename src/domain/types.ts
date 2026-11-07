// Alle beløb er heltal i øre (12.345,67 kr = 1234567) for at undgå afrundingsfejl.
// Datoer er ISO-strenge 'YYYY-MM-DD' (sorterer korrekt som tekst).

export type TxType = 'income' | 'expense' | 'internal' | 'outlay';

export const TX_TYPE_LABEL: Record<TxType, string> = {
  income: 'Indtægt',
  expense: 'Udgift',
  internal: 'Intern',
  outlay: 'Udlæg / gæld',
};

export interface Category {
  id: string;
  name: string;
  /**
   * income/expense: altid indtægt hhv. udgift (fx "Gaver modtaget" / "Gaver givet").
   * both: kan gå begge veje (fx renter, afkast) – positivt beløb er indtægt, negativt er udgift.
   */
  kind: 'income' | 'expense' | 'both';
  /** Undefined = hovedkategori. Ellers id på hovedkategorien. */
  parentId?: string;
  /** Passiv indkomst (penge der arbejder for dig). Undefined = gæt ud fra navnet. */
  passive?: boolean;
}

export interface Account {
  id: string;
  name: string;
  /**
   * bank: har importerede transaktioner med saldo.
   * valuation: værdi angives manuelt pr. dato (lån, depot, pension ...); ændring ud over overførsler = afkast/renter.
   * tracked: saldoen følger alene dine overførsler (fx "Jonas skylder mig", depositum).
   */
  kind: 'bank' | 'valuation' | 'tracked';
  /**
   * Postens naturlige side – bruges kun til fortegnet, når man taster en værdi (gæld skrives som positivt tal).
   * I balancen placeres posten efter sit faktiske fortegn: positiv = aktiv, negativ = passiv.
   */
  side: 'asset' | 'liability';
  /** Brugerens egen type (se AppData.accountTypes). Uden = "Ingen type". */
  typeId?: string;
  /** Ældre, foruddefineret type – migreres til en brugertype. */
  subtype?: string;
  /** Tekster der identificerer kontoen i andre kontis posteringstekster, fx "Min opsparing". */
  aliases: string[];
  /** For værdikonti: hvor ændringer, der ikke er forklaret af overførsler, bogføres (fx afkast eller renter). */
  defaultCategoryId?: string;
  /** Brugerens kommentar pr. periode (periodId → tekst). Kopieres til en ny periode fra den forrige. */
  notes?: Record<string, string>;
  /** Ældre kommentar uden periode – migreres til notes. */
  note?: string;
  /** Manuel åbningssaldo for bankkonti (ellers udledes den af første transaktions saldo). */
  openingBalance?: number;
  archived?: boolean;
}

/** Klassifikation af (en del af) en transaktion. */
export interface Classification {
  type: TxType;
  categoryId?: string;
  /** Udlæg: modpart (person). */
  counterparty?: string;
  /** Intern: modtagerkonto (valgfri; værdikonti bogføres direkte). */
  targetAccountId?: string;
}

export interface Split extends Classification {
  amount: number;
  note?: string;
}

export interface Tx {
  id: string;
  accountId: string;
  date: string;
  text: string;
  amount: number;
  balance?: number;
  bankCategory?: string;
  bankSubcategory?: string;
  /** Rækkefølge i importfilen (kronologisk), bruges som tie-break ved saldokæde. */
  seq: number;
  importedAt: string;
  /** Brugerens endelige afgørelse. Har altid forrang. */
  manual?: Classification;
  /** Opdeling af transaktionen. Summen skal give amount. Har forrang over manual. */
  splits?: Split[];
  /** Kommentar fra bankens eksport (fx en "Kommentar"-kolonne). Overskrives aldrig af brugeren. */
  note?: string;
  /** Brugerens egen note, skrevet i Finstate. */
  memo?: string;
}

export interface Rule {
  id: string;
  /** Normaliseret tekst (se normalize.ts). */
  pattern: string;
  match: 'exact' | 'contains';
  sign?: 'in' | 'out';
  accountId?: string;
  then: Classification;
  /**
   * Husket opdeling: faste beløb (positive øre, følger transaktionens fortegn) + præcis én linje uden
   * beløb, der får resten. Fx en løn: [{Pension: 1.000 kr}, {Løn: resten}].
   */
  splits?: { cls: Classification; amount?: number }[];
  createdAt: string;
}

export interface BankMapEntry {
  type: TxType;
  categoryId?: string;
}

export interface Valuation {
  id: string;
  accountId: string;
  date: string;
  /** Fortegnsbestemt: aktiver positive, gæld negativ. */
  value: number;
  /** Specificerede dele af værdiændringen (fx renter, skat). Fortegn = effekt på egenkapital. */
  adjustments: { id: string; categoryId: string; amount: number; note?: string }[];
  note?: string;
}

/** Manuelt tilgodehavende/gæld over for en person. */
export interface OpenItem {
  id: string;
  date: string;
  counterparty: string;
  /** + = personen skylder mig, − = jeg skylder personen. */
  amount: number;
  /** Posten på balancen (fx "Jonas skylder mig"). Uden: ældre data, bogføres pr. personnavn. */
  accountId?: string;
  /** Uden kategori = åbningspost (dateres bogføringsstart). Med kategori = bogføres som indtægt/udgift. */
  categoryId?: string;
  note?: string;
}

export interface Period {
  id: string;
  name: string;
  start: string;
  end: string;
  compareToId?: string;
  /** Brugeren har bekræftet, at balancen (alle aktiver og passiver) er komplet for perioden. */
  balanceConfirmed?: boolean;
  /** Poster i periodens balance (kopieres fra forrige periode). Poster med en saldo vises altid. */
  accountIds?: string[];
}

/** Brugerens egne posttyper (fx "Opsparing", "Lån"). "Ingen type" er altid en mulighed. */
export interface AccountTypeDef {
  id: string;
  name: string;
}

export interface ColumnMapping {
  date: number;
  text: number[];
  amount: number;
  balance?: number;
  category?: number;
  subcategory?: number;
  /** Brugerens egen kommentar i netbanken → note på transaktionen. */
  note?: number;
  /** Kontonavn/-nummer i filen – bruges kun til at vælge konto automatisk. */
  accountName?: number;
}

export interface Settings {
  /** Dagen før første periode. Åbningsbalancen dateres her; kun transaktioner efter tæller. */
  bookStart: string;
  /** Sat når brugeren selv har valgt bogføringsstart (ellers følger den data automatisk). */
  bookStartSet?: boolean;
  /** Brug bankens kategorier som første forslag (default: ja). */
  useBankCategories?: boolean;
  /** Indbygget forslag: kontonavn/alias i teksten → intern overførsel (default: ja). */
  autoAlias?: boolean;
  /** Indbygget forslag: samme beløb ind/ud på to egne konti inden for få dage → intern (default: ja). */
  autoPair?: boolean;
  /** Regler er en avanceret funktion – slået fra som standard. */
  rulesEnabled?: boolean;
  /** Guide: hjælpebokse brugeren har skjult, og om konti er gennemgået. */
  hiddenHelp?: string[];
  accountsConfirmed?: boolean;
  openingTransit: number;
  lastExportAt?: string;
  lastChangeAt?: string;
}

export interface AppData {
  version: 1;
  settings: Settings;
  accounts: Account[];
  /** Brugerens egne posttyper. */
  accountTypes: AccountTypeDef[];
  categories: Category[];
  rules: Rule[];
  bankMap: Record<string, BankMapEntry>;
  txs: Tx[];
  valuations: Valuation[];
  openItems: OpenItem[];
  periods: Period[];
  /** periodId -> slideKey -> brugerens tekst (overstyrer forslag). */
  slideNotes: Record<string, Record<string, string>>;
  /** header-signatur -> kolonnemapping. */
  importProfiles: Record<string, ColumnMapping>;
}

export const bankKey = (cat?: string, sub?: string) => `${cat ?? ''}|${sub ?? ''}`;
