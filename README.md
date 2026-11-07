# Finstate

Personligt financial statement (halvår/år) – dobbelt bogholderi, 100 % lokalt i browseren.

```bash
npm install
npm start        # åbner http://127.0.0.1:5173
npm test         # tests af regnskabsmotoren
```

> **Brug altid samme adresse** (`http://127.0.0.1:5173`). localStorage er bundet til adressen – `localhost:5173`
> eller en anden port ligner en tom app. Tag backup (knappen øverst til højre) efter hver arbejdsgang.

## Privatliv
- Ingen server, intet login, ingen analytics. En Content-Security-Policy i `index.html` forhindrer siden i at
  sende data nogen steder hen (kun dev-serverens egen websocket er tilladt).
- Data ligger i `localStorage` (nøgle `finstate:v1`). Backupfiler indeholder bankdata – `.gitignore` udelukker `*.csv` og backups.
- Demodata og eksempelkategorier er opdigtede. En lokal pre-commit-hook (`scripts/pre-commit`) kan blokere egne
  private ord fra en ikke-versioneret `.private-terms`-fil.

## Arbejdsgang
Start altid med en periode (H1, H2, helår eller egne datoer) øverst i menuen. Kategoritræet er fælles for alle perioder.

1. **Importér** CSV fra hver konto (overlap er ufarligt – dubletter genkendes på hash).
2. **Kategorisér** – kronologisk gennemgang eller grupperet; "Lignende" giver samme kategori til flere på én gang, "Opdel" deler et beløb.
3. **Overførsler** – interne overførsler parres på tværs af konti.
4. **Aktiver & passiver** – alle poster i ét samlet billede. Hver post har en valgfri egen type og enten
   *følger overførsler* eller *tastes selv*. Poster og kommentarer kopieres fra forrige periode.
5. **Regnskab** – resultat & balance med sammenligning; klik på et beløb for at se, hvad det består af; CSV-eksport.
6. **Slideshow** – genereret ud fra tallene med redigerbare kommentarer; præsentér eller gem som PDF.

## Design
Alt bliver til posteringer (`src/domain/ledger.ts`). Balancekonti: poster (`acc:<id>`) og `transit` (Penge undervejs).
Egenkapitalkonti: kategorier + `opening`. Hver hændelse er i balance, så **Δ egenkapital = resultat** gælder per konstruktion – og:

- en intern overførsel uden modpost i perioden står automatisk som *Penge undervejs*, og nulstilles når modposten lander;
- en post står som aktiv ved positiv saldo og som passiv ved negativ;
- poster der tastes selv: *uforklaret ændring = ny værdi − gammel værdi − overførsler* bogføres som afkast/renter (kan specificeres);
- kategorier er indtægt, udgift eller *begge veje* (fx renter): positivt beløb er indtægt, negativt udgift.

Klassifikation (`src/domain/classify.ts`), i prioriteret rækkefølge:
dit valg → regel → konto-alias → beløbsmatch mellem egne konti → bankmapping → bankens nøgleord.
Regler er en avanceret funktion, der er slået fra, til man slår den til under Indstillinger → Regler. Alle indbyggede
forslag kan ses og slås fra samme sted. Forslag fra banken skal godkendes i Kategorisér. Beløb er heltal i øre.

| Mappe | Indhold |
|---|---|
| `src/domain` | Ren TypeScript uden React: parsing, klassifikation, bogføring, kontroller, tekstforslag, backup |
| `src/store` | Zustand-store med localStorage-persist + handlinger |
| `src/ui` | React-visninger og SVG-diagrammer |
