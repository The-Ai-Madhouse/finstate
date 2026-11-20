# Finstate – designsprog

Finstates udseende er kraftigt inspireret af den danske budgetapp **Altid Hjem**: varm creme, en dyb skovgrøn, bløde pastelfarver,
store tal og runde, rolige former. Funktionerne og opsætningen er Finstates egne – det er kun udtrykket, vi låner.
**Alt nyt UI skal følge reglerne her**, så hele appen bliver ved med at ligne sig selv.

Alle farver, radier og skygger ligger som variabler øverst i `src/styles.css` (lys og mørk tilstand). Brug altid variablerne –
skriv aldrig en farvekode direkte i en komponent eller en ny CSS-regel.

## Farver

| Variabel | Bruges til |
|---|---|
| `--page` | Sidens baggrund (creme). |
| `--surface` / `--surface-2` | Kort og felter / rolige baggrunde inde i et kort (fx en valgt række, et felt i en liste). |
| `--ink` / `--ink-2` / `--muted` | Tekst: primær / sekundær / diskret. |
| `--brand`, `--brand-2`, `--brand-ink`, `--brand-muted` | Den mørkegrønne "hero"-flade: store tal, valgt menupunkt, primærknapper, aktive faner. |
| `--brand-glow` | Den klare grønne på mørkegrønt: ✓, "op"-piller, aktive markeringer. |
| `--mint`, `--butter`, `--lilac`, `--sky`, `--blush`, `--sand` | Pastelfarver til fliser, hjælpebokse, etiketter og sektioner. Tekst på pastel: `--pastel-ink`. |
| `--accent`, `--accent-soft` | Links, fokusringe og diskrete markeringer. |
| `--pos` / `--neg` | Beløb: op/ned. `--good`, `--warning`, `--critical` til status. |
| `--type-income/expense/internal` | Transaktionstyper (Indtægt/Udgift/Intern). |

- **Hver side har sin pastel** (`--tint`, sat via `.content[data-view=…]`): Overblik og Aktiver mint, Importér sky,
  Kategorisér lilla, Overførsler smør, Regnskab og Indstillinger sand, Slideshow rosa. Hjælpeboksen og infobokse bruger den.
  Får appen en ny side, så giv den en `--tint`.
- **Status** vises med pastel, ikke med kanter: advarsel = `--butter`, fejl = `--blush`, info = `--sky`, ok = `--mint`.
- Mørk tilstand er ikke en eftertanke: alle variabler har en mørk værdi. Tjek altid begge.

## Former og rum

- Runde hjørner: `--radius` (20px) på kort og fliser, `--radius-lg` (28px) på hero-flader og dialoger, `--radius-sm` (12px) på felter.
- **Knapper, faner, chips, badges og segmenterede valg er piller** (`border-radius: 999px`).
- Kort: `.card` – lys flade, næsten usynlig kant (`--ring`), blød skygge (`--shadow`), 22px luft.
- God luft: 28–32px om siden, 14–20px mellem kort.
- Ingen sorte bjælker, ingen VERSALER i overskrifter og etiketter. Sektionsetiketter er pastelpiller (fx `.fs-bar`).

## Typografi

- Skrift: **Plus Jakarta Sans** (pakket med appen via `@fontsource-variable/plus-jakarta-sans` – der hentes intet udefra).
- Sideoverskrift (`h1`): 30–32px, vægt 800, tæt (`letter-spacing: -0.03em`).
- Kortoverskrift: 17–18px, vægt 750.
- **Store tal er helten**: hovedtallet på en side står stort og fedt (fx `.hero-big` 44–68px, `.tile .val` 28px, vægt 800),
  med en kort forklaring under i almindelig tekst ("i nettoformue", "tilbage at betale i november").
- Beløb bruger `font-variant-numeric: tabular-nums` (klassen `.num`).

## Mønstre

- **Hero** (`.hero`): mørkegrøn flade øverst på en side med ét stort tal, en forklaring og evt. en pille (`.hero-pill`) for ændringen.
- **Pastelfliser** (`.tiles > .tile`): nøgletal på skiftende pastel (sky, lilla, sand, rosa).
- **Segmenteret valg** (`.seg`): pillebeholder i `--surface-2`; det valgte er en hvid pille med lille skygge (som "Mine | Fælles").
- **Faner** (`.tabs`): pillebeholder; den valgte fane er mørkegrøn.
- **Menu**: creme baggrund, menupunkter som piller; det valgte er mørkegrønt.
- **Dialoger** (`.modal`): store runde hjørner, sløret baggrund, glider blødt ind.
- **Kalender og søjler** (Dagligt budget): mørkegrøn flade med lysere felter, ✓ i `--brand-glow`, stiplet gennemsnitslinje.

## Bevægelse ("smoothness")

- Overgange med `--ease` (blød ud-bremsning), typisk 0.15–0.3s: hover, valg, faner.
- Sider toner blidt ind (`page-in`), dialoger og popovers glider ind (`modal-in`, `pop-in`), knapper giver efter ved klik (`scale(0.97)`).
- Alt bevægelse slås fra ved `prefers-reduced-motion`.

## Tjekliste for nyt UI

1. Kun variabler – ingen faste farvekoder.
2. Piller til knapper/faner/chips, runde kort, ingen versaler.
3. Det vigtigste tal står stort; forklaringen står under i almindelig tekst.
4. Tjek lys og mørk tilstand og mobilbredde (≤ 760px).
5. Fokus skal kunne ses (`:focus-visible`), og bevægelse skal respektere `prefers-reduced-motion`.
