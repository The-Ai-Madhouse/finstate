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
  /** Ældre: med i afstemningen i alle perioder – migreres til Period.settle (afstemning vælges nu pr. periode). */
  settle?: boolean;
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
  /** Intern: pengene kommer fra (eller er) penge undervejs fra en tidligere periode – fx "transit:<konto>" eller "transit". */
  transitRef?: string;
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
  /** Parret manuelt med denne transaktion (modposten peger tilbage). Har forrang over automatisk parring. */
  pairWith?: string;
  /** Brugeren har ophævet en automatisk parring – transaktionen parres ikke automatisk igen. */
  noAutoPair?: boolean;
  /** "Hører sammen": transaktioner med samme værdi er knyttet sammen af brugeren (kun en note – ændrer ikke regnskabet). */
  link?: string;
  /** Køb/salg af værdipapirer med kurtage (fundet ved import). Ændrer intet af sig selv – bruges til at foreslå en opdeling. */
  trade?: TradeInfo;
}

/** Kurtage på en handel (alle beløb i øre, uden fortegn). Køb: i alt = pris + kurtage. Salg: i alt = pris − kurtage. */
export interface TradeInfo {
  /** Kurtage og gebyrer. */
  fee: number;
  /** Købs- eller salgsprisen uden kurtage. */
  gross: number;
  side: 'buy' | 'sell';
}

/** En importeret fil: hvilke transaktioner den indeholdt (også dem, der fandtes i forvejen). */
export interface ImportRecord {
  id: string;
  fileName: string;
  accountId: string;
  importedAt: string;
  txIds: string[];
  /** Perioden filen dækker (fx bankens eksportperiode) – også dage uden bevægelser. Standard: første og sidste transaktion. */
  from?: string;
  to?: string;
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

/**
 * En afstemningsgruppe på en post, der følger overførsler (fx "Jonas skylder mig"): bevægelser,
 * der hører sammen – typisk et udlæg og tilbagebetalingen. Summen 0 = udlignet.
 * Nøgler: "tx:<transaktions-id>" eller "oi:<åben post-id>" (startsaldo/afskrivning).
 */
export interface Match {
  id: string;
  accountId: string;
  keys: string[];
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
  /** Bankkonti hvor brugeren har accepteret, at data ikke dækker hele perioden (fx lukket konto). */
  coverageOk?: string[];
  /** Hvad Regnskab viser af året: hele året (standard) eller kun et halvår. */
  show?: 'year' | 'h1' | 'h2';
  /** Poster, der afstemmes i netop denne periode (fx "Jonas skylder mig") – vælges pr. periode. */
  settle?: string[];
  /**
   * Afstemning: det, du har accepteret ikke går op endnu og tager med til næste periode
   * (bevægelser "tx:…"/"primo:…" eller grupper "match:…"). Beløbet bliver stående på posten og indgår i næste periodes saldo primo.
   */
  settleCarry?: string[];
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
  /** Værdipapirhandel: kurtage/gebyrer – så kurtagen kan skilles fra købs-/salgsprisen. */
  fee?: number;
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

/** Dagligt budget: hvor ofte et abonnement eller en fast udgift trækkes. */
export type Cadence = 'monthly' | 'quarterly' | 'halfyear' | 'yearly';

/** Et abonnement, brugeren selv har tilføjet – eller rettet (så har det key fra det fundne abonnement). */
export interface Subscription {
  id: string;
  /** Nøglen på det automatisk fundne abonnement, der er rettet ("<konto>|<normaliseret tekst>"). Uden = tilføjet manuelt. */
  key?: string;
  name: string;
  /** Beløb pr. træk (positive øre). */
  amount: number;
  cadence: Cadence;
  /** En dato, hvor det trækkes – de øvrige regnes ud herfra. */
  anchor: string;
  accountId?: string;
  /** Tekst i banken, der genkender trækket (manuelle abonnementer). Standard: navnet. */
  match?: string;
  note?: string;
}

/** Dagligt budget – helt adskilt fra financial statementet. Kun brugerens rettelser gemmes; resten findes i transaktionerne. */
export interface BudgetData {
  subscriptions: Subscription[];
  /** Fundne abonnementer, brugeren har sagt ikke er abonnementer (nøgler). */
  dismissed: string[];
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
  /** Importerede filer. */
  imports: ImportRecord[];
  /** Afstemning af udlæg/tilgodehavender: hvad hører sammen. */
  matches: Match[];
  /** "Hører sammen"-grupper (Tx.link): en afskrevet difference (beløbet, da den blev godkendt) og evt. en note. */
  linkGroups?: Record<string, { accepted?: number; note?: string }>;
  periods: Period[];
  /** periodId -> slideKey -> brugerens tekst (overstyrer forslag). */
  slideNotes: Record<string, Record<string, string>>;
  /** header-signatur -> kolonnemapping. */
  importProfiles: Record<string, ColumnMapping>;
  /** Dagligt budget (abonnementer og faste udgifter). Mangler i ældre data. */
  budget?: BudgetData;
  /** Opsparingsmål (kun planlægning – flytter ingen penge og påvirker ikke regnskabet). Mangler i ældre data. */
  goals?: Goal[];
}

export type GoalKind = 'travel' | 'holiday' | 'buffer' | 'car' | 'home' | 'gift' | 'education' | 'other';

/** En post i målets budget, fx "Fly 8.000 kr." (øre). */
export interface GoalCost { id: string; label: string; amount: number }

/** Et opsparingsmål – til at se, hvad der skal til, og om det er realistisk. */
export interface Goal {
  id: string;
  name: string;
  kind: GoalKind;
  /** Målbeløbet (øre). Har målet budgetposter, er målet summen af dem. */
  target: number;
  costs?: GoalCost[];
  /** Det, du allerede har sparet op til målet (skrevet ind af dig – flytter ingen penge). */
  saved: number;
  /** Hvornår pengene skal være der. */
  deadline?: string;
  /** Hvad du regner med at kunne spare op pr. måned til målet (øre). */
  monthly?: number;
  priority: 1 | 2 | 3;
  note?: string;
  createdAt: string;
}

export const bankKey = (cat?: string, sub?: string) => `${cat ?? ''}|${sub ?? ''}`;
