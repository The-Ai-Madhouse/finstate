# Finstate – noter til Claude

- Al tekst i appen og i koden (kommentarer, commit-beskeder) er på dansk.
- Beløb er heltal i øre; datoer er ISO-strenge (`YYYY-MM-DD`). Se `src/domain/types.ts`.
- Kør `npm test` og `npm run typecheck` før commit.

## Design – gælder ALT UI, også fremover

Udseendet er kraftigt inspireret af budgetappen Altid Hjem (creme, skovgrøn, pastel, store tal, piller, bløde overgange).
**Læs og følg `DESIGN.md`, før du laver eller ændrer noget i brugerfladen.** Kort fortalt:

- Brug kun variablerne fra toppen af `src/styles.css` (`--brand`, `--mint`, `--surface` …) – aldrig faste farvekoder.
- Knapper, faner, chips og segmenterede valg er piller; kort har store runde hjørner; ingen versaler og ingen sorte bjælker.
- Det vigtigste tal på en side står stort og fedt (hero eller pastelflise) med en kort forklaring under.
- Tjek både lys og mørk tilstand og mobilbredde.

## Login

Lokalt (`npm start`, 127.0.0.1) er der intet login; data er krypteret med nøglen i `local.key`. Login med adgangskode + 2FA
kræves kun, når Finstate kører på netværket (`npm run serve`). Se `server/storage.ts`.
