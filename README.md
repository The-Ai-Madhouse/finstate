# Finstate

Personligt financial statement (årligt – Regnskab kan også vise et halvår) – dobbelt bogholderi, 100 % lokalt i browseren.

```bash
npm install
npm start        # åbner http://127.0.0.1:5173
npm test         # tests af regnskabsmotoren
```

> **Login med 2FA og kryptering.** Første gang vælger du en adgangskode og tilføjer Finstate i en 2FA-app
> (Google Authenticator, 1Password …). Login holder i 4 uger pr. enhed. Data gemmes **krypteret** (AES-256-GCM) i
> `~/Documents/Finstate/` (anden mappe: `FINSTATE_DIR=/sti npm start` – altid uden for projektet) og kan kun låses
> op med adgangskode + 2FA. Glemmer du adgangskoden, kan data ikke gendannes.
>
> **Versioner** (knappen øverst): gem en navngiven milepæl, se hvad der er ændret siden, og gå tilbage.
>
> **Raspberry Pi:** `npm run build && npm run serve` kører Finstate som selvstændig server. Se
> [deploy/RASPBERRY-PI.md](deploy/RASPBERRY-PI.md) for sikker opsætning **kun på hjemmenetværket** (HTTPS, firewall, afviser alt udefra),
> systemd og backup til din computer (`scripts/backup-from-pi.sh`).

## Privatliv
- Ingen server, intet login, ingen analytics. En Content-Security-Policy i `index.html` forhindrer siden i at
  sende data nogen steder hen (kun dev-serverens egen websocket er tilladt).
- Data ligger krypteret i datamappen – intet gemmes i browseren. Serveren svarer kun Finstate selv (127.0.0.1 eller navne i `FINSTATE_ALLOWED_HOSTS`; Host/Origin tjekkes), kræver login til alt andet end selve login'et, spærrer efter gentagne forkerte forsøg og nægter en datamappe inde i projektet. Ukrypterede eksporter indeholder bankdata – `.gitignore` udelukker `*.csv` og backups.
- Demodata og eksempelkategorier er opdigtede. En lokal pre-commit-hook (`scripts/pre-commit`) kan blokere egne
  private ord fra en ikke-versioneret `.private-terms`-fil.

## Arbejdsgang
Start altid med en periode (H1, H2, helår eller egne datoer) øverst i menuen. Kategoritræet er fælles for alle perioder.

1. **Importér** CSV fra hver konto (overlap er ufarligt – dubletter genkendes på hash). Importerede filer kan ses og fjernes igen.
2. **Kategorisér** – gennemgang eller grupperet, med faste filtre (tekst/noter, beløb, dato, konto, kategori, type) og sortering; "Lignende" giver samme kategori til flere på én gang, "Opdel" deler et beløb, og "⇄ Par" parrer to transaktioner (fx et udlæg og indbetalingen) – går de ikke op, vælger man, hvor resten hører hjemme.
3. **Overførsler** – interne overførsler parres på tværs af konti. Under **Afstemning** ses det, du har valgt at afstemme i perioden: poster (fx en person) og parrede transaktioner – og om det går op.
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
- kategoritræet kan have underkategorier i vilkårlig dybde; en kategoris beløb er summen af hele dens undertræ.

Klassifikation (`src/domain/classify.ts`), i prioriteret rækkefølge:
dit valg → regel → konto-alias → beløbsmatch mellem egne konti → bankmapping → bankens nøgleord.
Regler er en avanceret funktion, der er slået fra, til man slår den til under Indstillinger → Regler. Alle indbyggede
forslag kan ses og slås fra samme sted. Forslag fra banken skal godkendes i Kategorisér. Beløb er heltal i øre.

| Mappe | Indhold |
|---|---|
| `src/domain` | Ren TypeScript uden React: parsing, klassifikation, bogføring, kontroller, tekstforslag, backup |
| `src/store` | Zustand-store med localStorage-persist + handlinger |
| `src/ui` | React-visninger og SVG-diagrammer |
