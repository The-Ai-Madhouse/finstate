/**
 * Fiktive demodata (halvandet år: hele 2025 og 1. halvår af 2026) for en opdigtet person, i et generisk bank-CSV-format,
 * så værktøjet kan afprøves uden rigtige bankdata. Alle navne er opdigtede. Genereres deterministisk.
 */
import { buildTxs, guessMapping, isCompleteMapping, parseCsv } from './csv';
import { defaultCategories, emptyData } from './defaults';
import type { AppData, Tx } from './types';
import { addDays } from './util';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

type Row = { date: string; cat: string; sub: string; text: string; amount: number; note?: string };

const fmt = (ore: number) =>
  (ore < 0 ? '-' : '') + new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true }).format(Math.abs(ore) / 100);
const dk = (iso: string) => iso.split('-').reverse().join('.');

function toCsv(rows: Row[], opening: number): string {
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let bal = opening;
  const lines = rows.map((r) => {
    bal += r.amount;
    return [dk(r.date), r.text, fmt(r.amount), fmt(bal), r.cat, r.sub, r.note ?? ''].map((c) => `"${c}"`).join(';');
  });
  lines.reverse(); // banker eksporterer typisk nyeste først
  return ['"Bogføringsdato";"Beskrivelse";"Beløb";"Saldo";"Kategori";"Underkategori";"Kommentar"', ...lines].join('\n');
}

export function demoData(): AppData {
  const r = rng(7);
  const amt = (min: number, max: number) => -Math.round((min + r() * (max - min)) * 100);
  const lon: Row[] = [];
  const ops: Row[] = [];
  const months = [...Array(18)].map((_, i) => `${2025 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  months.forEach((m, i) => {
    const h2 = i < 12; // 2025: lidt lavere løn og priser end 2026
    lon.push({ date: `${m}-01`, cat: 'Indkomst', sub: 'Løn', text: 'Løn Nordlys Design ApS', amount: (h2 ? 24300 : 25100) * 100 });
    if (i % 3 === 1) lon.push({ date: `${m}-19`, cat: 'Indkomst', sub: 'Øvrig indkomst', text: 'Faktura 10' + i + ' Atelier Krogh', amount: 3800_00 });
    lon.push({ date: `${m}-01`, cat: 'Bolig', sub: 'Husleje', text: 'Husleje Boligforeningen Kastanjen', amount: -8450_00 });
    lon.push({ date: `${m}-04`, cat: 'Bolig', sub: 'El og varme', text: 'Betalingsservice Lysværket', amount: amt(450, 780) });
    lon.push({ date: `${m}-05`, cat: 'Bolig', sub: 'Internet', text: 'Betalingsservice Fiberby', amount: -249_00 });
    lon.push({ date: `${m}-06`, cat: 'Underholdning', sub: 'Streaming', text: 'Streamio abonnement', amount: -119_00 });
    lon.push({ date: `${m}-08`, cat: 'Bolig', sub: 'Telefon', text: 'Mobilselskabet Prik', amount: -129_00 });
    lon.push({ date: `${m}-09`, cat: 'Fritid', sub: 'Sport', text: 'Fitness Puls medlemskab', amount: -279_00 });
    lon.push({ date: `${m}-10`, cat: 'Overførsler', sub: 'Egne konti', text: 'Overførsel til Fælles opsparing', amount: -4000_00 });
    ops.push({ date: `${m}-10`, cat: 'Overførsler', sub: 'Egne konti', text: 'Overførsel fra Lønkonto', amount: 4000_00 });
    lon.push({ date: `${m}-15`, cat: 'Overførsler', sub: 'Lån', text: 'Afdrag billån Bilfinans', amount: -2100_00 });
    for (let w = 0; w < 4; w++) {
      const d = String(3 + w * 7).padStart(2, '0');
      lon.push({ date: `${m}-${d}`, cat: 'Dagligvarer', sub: 'Supermarked', text: `Kortkøb Købmand Hansen ${d}.${m.slice(5)}`, amount: amt(h2 ? 260 : 300, h2 ? 690 : 740) });
    }
    lon.push({ date: `${m}-12`, cat: 'Transport', sub: 'Brændstof', text: 'Kortkøb Tankstation Vest', amount: amt(350, 620) });
    lon.push({ date: `${m}-18`, cat: 'Mad og drikke', sub: 'Café', text: 'Kortkøb Café Solsikke', amount: amt(55, 140) });
    if (i % 3 === 0) {
      lon.push({ date: `${m}-14`, cat: 'Mad og drikke', sub: 'Restaurant', text: 'Kortkøb Restaurant Havnehuset', amount: -1200_00 });
      lon.push({ date: `${m}-15`, cat: 'Overførsler', sub: 'MobilePay', text: 'MobilePay Jonas Lind', amount: 400_00 });
      lon.push({ date: `${m}-16`, cat: 'Overførsler', sub: 'MobilePay', text: 'MobilePay Ida Krogh', amount: 400_00 });
    }
    if (i === 3 || i === 9) lon.push({ date: `${m}-22`, cat: 'Overførsler', sub: 'MobilePay', text: 'MobilePay Sara Holt', amount: -250_00 });
    if (i % 3 === 2) lon.push({ date: `${m}-27`, cat: 'Overførsler', sub: 'Egne konti', text: 'Overførsel til Aktiedepot', amount: -1500_00 });
    ops.push({ date: `${m}-28`, cat: 'Indkomst', sub: 'Renter', text: 'Rente', amount: Math.round(40 + r() * 25) * 100 });
  });
  lon.push({ date: '2025-08-06', cat: 'Fritid', sub: 'Rejser', text: 'Færgeselskabet Bølgen billetter', amount: -1840_00 });
  lon.push({ date: '2025-12-18', cat: 'Shopping', sub: 'Gaver', text: 'Kortkøb Legetøjsbutikken Pip', amount: -960_00 });
  lon.push({ date: '2025-12-24', cat: 'Overførsler', sub: 'MobilePay', text: 'MobilePay Faster Grete', amount: 500_00 });
  lon.push({ date: '2025-08-20', cat: 'Overførsler', sub: 'MobilePay', text: 'MobilePay Jonas Lind', amount: 200_00, note: 'Tilbage for koncertbilletten' });
  lon.push({ date: '2026-03-03', cat: 'Shopping', sub: 'Tøj', text: 'Kortkøb Tøjhuset', amount: -699_00 });
  lon.push({ date: '2026-04-11', cat: 'Sundhed', sub: 'Tandlæge', text: 'Tandlægerne i Byen', amount: -850_00 });
  // Den forsinkede overførsel: sendt nytårsaften, landet 2. januar.
  lon.push({ date: '2025-12-31', cat: 'Overførsler', sub: 'Egne konti', text: 'Overførsel til Fælles opsparing nytår', amount: -6000_00 });
  ops.push({ date: addDays('2025-12-31', 2), cat: 'Overførsler', sub: 'Egne konti', text: 'Overførsel fra Lønkonto nytår', amount: 6000_00 });

  const data: AppData = {
    ...emptyData(),
    accountTypes: [
      { id: 'type-bank', name: 'Bankkonti' },
      { id: 'type-inv', name: 'Investeringer' },
      { id: 'type-loan', name: 'Lån' },
      { id: 'type-people', name: 'Personer' },
    ],
    accounts: [
      { id: 'acc-loen', name: 'Lønkonto', kind: 'bank', typeId: 'type-bank', side: 'asset', aliases: ['Lønkonto'] },
      { id: 'acc-ops', name: 'Fælles opsparing', kind: 'bank', typeId: 'type-bank', side: 'asset', aliases: ['Fælles opsparing'] },
      { id: 'acc-depot', name: 'Aktiedepot', kind: 'valuation', typeId: 'type-inv', side: 'asset', aliases: ['Aktiedepot'], defaultCategoryId: 'bo-renter-afkast' },
      { id: 'acc-bil', name: 'Billån', kind: 'valuation', typeId: 'type-loan', side: 'liability', aliases: ['billån'], defaultCategoryId: 'bo-renter-afkast' },
      { id: 'acc-jonas', name: 'Jonas skylder mig', kind: 'tracked', typeId: 'type-people', side: 'asset', aliases: [] },
    ],
    categories: defaultCategories(),
  };
  data.settings.bookStart = '2024-12-31';
  data.settings.bookStartSet = true;
  data.settings.rulesEnabled = false;
  const imp = (csv: string, accountId: string, fileName: string): Tx[] => {
    const sheet = parseCsv(csv);
    const m = guessMapping(sheet);
    if (!isCompleteMapping(m)) throw new Error('demo mapping');
    data.importProfiles[sheet.headerSignature] = m;
    const txs = buildTxs(sheet, m, accountId).txs;
    data.imports.push({ id: `imp-${accountId}`, fileName, accountId, importedAt: '2026-07-02T09:00:00.000Z', txIds: txs.map((t) => t.id) });
    return txs;
  };
  data.txs = [...imp(toCsv(lon, 12400_00), 'acc-loen', 'lonkonto-2025-01_2026-06.csv'), ...imp(toCsv(ops, 52000_00), 'acc-ops', 'opsparing-2025-01_2026-06.csv')];
  // Jonas betaler koncertbilletten tilbage – en intern overførsel fra posten "Jonas skylder mig".
  data.txs = data.txs.map((t) => (t.date === '2025-08-20' && t.text === 'MobilePay Jonas Lind' ? { ...t, manual: { type: 'internal', targetAccountId: 'acc-jonas' } } : t));
  data.valuations = [
    { id: 'v-dep-s', accountId: 'acc-depot', date: '2024-12-31', value: 26800_00, adjustments: [] },
    { id: 'v-dep-0', accountId: 'acc-depot', date: '2025-06-30', value: 31000_00, adjustments: [] },
    { id: 'v-dep-1', accountId: 'acc-depot', date: '2025-12-31', value: 35650_00, adjustments: [] },
    { id: 'v-dep-2', accountId: 'acc-depot', date: '2026-06-30', value: 40100_00, adjustments: [] },
    { id: 'v-bil-s', accountId: 'acc-bil', date: '2024-12-31', value: -79200_00, adjustments: [] },
    { id: 'v-bil-0', accountId: 'acc-bil', date: '2025-06-30', value: -68000_00, adjustments: [] },
    { id: 'v-bil-1', accountId: 'acc-bil', date: '2025-12-31', value: -56900_00, adjustments: [] },
    { id: 'v-bil-2', accountId: 'acc-bil', date: '2026-06-30', value: -45700_00, adjustments: [] },
  ];
  data.openItems = [{ id: 'oi-demo', date: '2024-12-31', counterparty: 'Jonas skylder mig', accountId: 'acc-jonas', amount: 200_00, note: 'Koncertbillet fra december' }];
  const ids = data.accounts.map((a) => a.id);
  data.periods = [
    { id: 'p-2025', name: '2025', start: '2025-01-01', end: '2025-12-31', accountIds: ids },
    // 2026 er i gang – Regnskab viser 1. halvår.
    { id: 'p-2026', name: '2026', start: '2026-01-01', end: '2026-12-31', accountIds: ids, show: 'h1' },
  ];
  data.accounts = data.accounts.map((a) => (a.id === 'acc-bil' ? { ...a, notes: { 'p-2025': 'Fast rente 4,9 %', 'p-2026': 'Fast rente 4,9 %' } } : a));
  data.bankMap = {
    'Dagligvarer|Supermarked': { type: 'expense', categoryId: 'ex-dagligvarer' },
    'Bolig|Husleje': { type: 'expense', categoryId: 'ex-bolig--husleje' },
  };
  return data;
}
