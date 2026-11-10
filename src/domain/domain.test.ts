import { describe, expect, it } from 'vitest';
import { applyBackup, makeBackup, parseBackup } from './backup';
import { resolveAll } from './classify';
import { accountHint, buildTxs, decodeBytes, guessMapping, isCompleteMapping, parseCsv } from './csv';
import { demoData } from './demo';
import { defaultCategories, emptyData } from './defaults';
import { buildEngine, periodChecks, withAutoBookStart } from './engine';
import { parseAmount, parseDate } from './format';
import { balancesAt } from './ledger';
import { narrative } from './insights';
import { guessCounterparty, normalizeText } from './normalize';
import { orderChain } from './reconcile';
import type { Tx } from './types';

describe('parsing', () => {
  it('parses Danish and English amounts', () => {
    expect(parseAmount('1.234,56')).toBe(123456);
    expect(parseAmount('-1.234,56')).toBe(-123456);
    expect(parseAmount('1234,5')).toBe(123450);
    expect(parseAmount('1,234.56')).toBe(123456);
    expect(parseAmount('1.234')).toBe(123400);
    expect(parseAmount('12.50')).toBe(1250);
    expect(parseAmount('−99,00')).toBe(-9900);
    expect(parseAmount('200-')).toBe(-20000);
    expect(parseAmount('abc')).toBeNull();
  });
  it('parses dates', () => {
    expect(parseDate('31.12.2025')).toBe('2025-12-31');
    expect(parseDate('2025-12-31')).toBe('2025-12-31');
    expect(parseDate('1/2/26')).toBe('2026-02-01');
    expect(parseDate('hej')).toBeNull();
  });
  it('normalizes recurring texts', () => {
    expect(normalizeText('Dankort-nota Købmand Hansen 4001 10.07')).toBe('købmand hansen');
    expect(normalizeText('Visa/Dankort Café Solsikke')).toBe('café solsikke');
    expect(normalizeText('Fitness Puls medlemskab')).toBe('fitness puls medlemskab');
    expect(guessCounterparty('MobilePay Jonas Lind')).toBe('Jonas Lind');
    expect(guessCounterparty('MobilePay: ida krogh 12345678')).toBe('Ida Krogh');
  });
  it('decodes windows-1252', () => {
    const bytes = new Uint8Array([0x42, 0x65, 0x6c, 0xf8, 0x62]); // "Beløb" i cp1252
    expect(decodeBytes(bytes.buffer)).toBe('Beløb');
  });
  it('detects columns behind metadata lines and orders newest-first files', () => {
    const csv = 'Kontoudtog;Lønkonto\n\nDato;Tekst;Beløb;Saldo\n03.01.2026;B;-10,00;80,00\n02.01.2026;A;-10,00;90,00';
    const sheet = parseCsv(csv);
    const m = guessMapping(sheet);
    expect(isCompleteMapping(m)).toBe(true);
    const { txs, reversed } = buildTxs(sheet, m as never, 'a');
    expect(reversed).toBe(true);
    expect(txs.map((t) => t.text)).toEqual(['A', 'B']);
    // Samme eksport to gange → samme id'er (ingen dubletter)
    expect(buildTxs(sheet, m as never, 'a').txs.map((t) => t.id)).toEqual(txs.map((t) => t.id));
  });
});

describe('bankformat med hoved-/underkategori, kommentar og kontonavn', () => {
  const csv = [
    '"Dato";"Tekst";"Beløb";"Saldo";"Afstemt";"Kontonummer";"Kontonavn";"Hovedkategori";"Kategori";"Kommentar"',
    '"15.01.2025";"KORTKØB KØBMAND HANSEN 7";"-32,00";"3.299,65";"Ja";"0000 1234567";"Min lønkonto";"Mad og indkøb";"Dagligvarer";"Kage til fredagsbaren"',
    '"03.01.2025";"KORTKØB TANKSTATION VEST";"-460,00";"3.331,65";"Ja";"0000 1234567";"Min lønkonto";"Transport";"Brændstof";""',
  ].join('\n');
  it('maps hoved-/underkategori, kommentar and kontonavn', () => {
    const sheet = parseCsv(csv);
    const m = guessMapping(sheet);
    expect(sheet.header[m.category!]).toBe('Hovedkategori');
    expect(sheet.header[m.subcategory!]).toBe('Kategori');
    expect(sheet.header[m.note!]).toBe('Kommentar');
    expect(accountHint(sheet, m)).toBe('Min lønkonto');
    const { txs } = buildTxs(sheet, m as never, 'acc-a');
    expect(txs[1].note).toBe('Kage til fredagsbaren');
    expect(txs[1].bankSubcategory).toBe('Dagligvarer');
    expect(normalizeText(txs[0].text)).toBe('tankstation vest');
  });
  it('follows the data with book start and can ignore bank categories', () => {
    const sheet = parseCsv(csv);
    const d = { ...emptyData(), categories: defaultCategories(), txs: buildTxs(sheet, guessMapping(sheet) as never, 'acc-a').txs };
    expect(withAutoBookStart(d).settings.bookStart).toBe('2024-12-31');
    expect(withAutoBookStart({ ...d, settings: { ...d.settings, bookStart: '2025-06-30', bookStartSet: true } }).settings.bookStart).toBe('2025-06-30');
    const shop = d.txs.find((t) => t.text.includes('HANSEN'))!;
    const r = resolveAll(d).get(shop.id)!;
    expect(r.source).toBe('bankguess');
    expect(r.lines[0].categoryId).toBe('ex-dagligvarer');
    expect(resolveAll({ ...d, settings: { ...d.settings, useBankCategories: false } }).get(shop.id)!.source).toBe('none');
    // Uden en passende kategori hos brugeren gættes der ikke.
    expect(resolveAll({ ...d, categories: [] }).get(shop.id)!.source).toBe('none');
  });
});

describe('saldokæde', () => {
  const tx = (id: string, date: string, amount: number, balance: number, seq: number): Tx => ({ id, accountId: 'a', date, text: id, amount, balance, seq, importedAt: '' });
  it('orders same-day transactions by chain and finds gaps', () => {
    const { ordered, breaks } = orderChain([tx('2', '2026-01-01', -5, 85, 0), tx('1', '2026-01-01', -10, 90, 1), tx('3', '2026-01-05', -1, 50, 2)]);
    expect(ordered.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].diff).toBe(51 - 85);
  });
});

describe('demo: hele motoren', () => {
  const data = demoData();
  const e = buildEngine(data);
  const [h2, h1] = data.periods; // 2025 (hele året) og 2026 (i gang)

  it('balances every period by construction', () => {
    for (const p of data.periods) {
      const s = e.statement(p);
      expect(s.equityClose - s.equityOpen).toBe(s.result + s.openingInPeriod);
      expect(s.assetsClose - s.liabClose).toBe(s.equityClose);
    }
  });

  it('bank ledger matches the bank saldo and has no chain breaks', () => {
    const checks = periodChecks(e, h1);
    expect(checks.filter((c) => c.level === 'error')).toEqual([]);
    expect(checks.find((c) => c.id === 'balance')?.level).toBe('ok');
  });

  it('moves the delayed new-year transfer to "Penge undervejs" and clears it next period', () => {
    // Undervejs til Fælles opsparing – dér skal pengene lande.
    expect(balancesAt(e.ledger, '2025-12-31').get('transit:acc-ops')).toBe(600000);
    expect(balancesAt(e.ledger, '2026-01-02').get('transit:acc-ops') ?? 0).toBe(0);
    const s = e.statement(h2);
    const row = s.rows.find((r) => r.ref === 'transit:acc-ops')!;
    expect([row.close, row.label, row.kind]).toEqual([600000, 'Undervejs til Fælles opsparing', 'transit']);
  });

  it('pairs internal transfers and books depot transfers directly', () => {
    const pairs = [...e.resolved.values()].filter((r) => r.pairId).length;
    expect(pairs).toBeGreaterThanOrEqual(24); // 12 måneder × 2 sider (+ nytår)
    const dep = e.statement(h2).rows.find((r) => r.ref === 'acc:acc-depot')!;
    expect(dep.close).toBe(3565000);
  });

  it('follows transfers for a tracked post', () => {
    const jonas = e.statement(h2).rows.find((r) => r.ref === 'acc:acc-jonas')!;
    expect([jonas.open, jonas.close]).toEqual([20000, 0]);
  });

  it('keeps the user in charge (no rules by default)', () => {
    expect(data.settings.rulesEnabled).toBe(false);
    const tx = data.txs.find((t) => t.text.startsWith('Fitness Puls'))!;
    const d2 = { ...data, txs: data.txs.map((t) => (t.id === tx.id ? { ...t, manual: { type: 'expense' as const, categoryId: 'ex-hobby-sport' } } : t)) };
    expect(resolveAll(d2).get(tx.id)!.lines[0].categoryId).toBe('ex-hobby-sport');
    expect(resolveAll(d2).get(tx.id)!.source).toBe('manual');
  });

  it('writes a narrative', () => {
    const n = narrative(e.statement(h1), e.statement(h2));
    expect(n.summary).toContain('2026');
    expect(n.progress.length + n.setbacks.length).toBeGreaterThan(0);
  });
});

describe('backup', () => {
  it('starts completely empty', () => {
    const d = emptyData();
    expect([d.accounts, d.accountTypes, d.categories, d.rules, d.txs]).toEqual([[], [], [], [], []]);
  });
  it('round-trips and merges', () => {
    const d = demoData();
    const b = parseBackup(JSON.stringify(makeBackup(d, 'full')));
    expect(applyBackup(emptyData(), b, 'replace').txs).toHaveLength(d.txs.length);
    const rules = parseBackup(JSON.stringify(makeBackup(d, 'rules')));
    const merged = applyBackup({ ...emptyData(), txs: d.txs.slice(0, 3) }, rules, 'merge');
    expect(merged.txs).toHaveLength(3);
    expect(() => parseBackup('{"app":"x"}')).toThrow();
  });
});

describe('månedligt cashflow', () => {
  it('uses the actual period length', async () => {
    const { periodMonths, perMonth, cashflow, isPassive } = await import('./cashflow');
    expect(periodMonths({ start: '2025-01-01', end: '2025-12-31' })).toBeCloseTo(11.99, 1);
    expect(periodMonths({ start: '2025-01-01', end: '2025-06-30' })).toBeCloseTo(5.95, 2);
    expect(perMonth(600000, periodMonths({ start: '2025-01-01', end: '2025-06-30' }))).toBe(100896);
    const d = demoData();
    const e = buildEngine(d);
    const s = e.statement(d.periods[1]);
    const cf = cashflow(s, d.categories);
    expect(cf.cashflowM).toBe(cf.incomeM - cf.expenseM);
    expect(Math.abs(cf.cashflowM * cf.months - s.result)).toBeLessThan(200); // afrunding pr. måned
    expect(isPassive(d.categories, 'bo-renter-afkast')).toBe(true);
    expect(isPassive(d.categories, 'in-loen')).toBe(false);
    expect(cf.passive).toBe(s.income.find((c) => c.id === 'bo-renter-afkast')?.amount ?? 0);
    expect(isPassive([...d.categories.map((c) => (c.id === 'bo-renter-afkast' ? { ...c, passive: false } : c))], 'bo-renter-afkast')).toBe(false);
  });
});

describe('importdækning', () => {
  it('reports whether bank data covers the period', async () => {
    const { importCoverage } = await import('./engine');
    const d = demoData();
    const [h2, h1] = d.periods;
    expect(importCoverage(d, h2).every((c) => c.coversStart && c.coversEnd)).toBe(true);
    const later = { id: 'x', name: '2026 H2', start: '2026-07-01', end: '2026-12-31' };
    const cov = importCoverage(d, later, '2027-02-01');
    expect(cov.every((c) => !c.coversEnd && !c.coversStart)).toBe(true);
    expect(importCoverage(d, h1, '2026-07-01')[0].coversEnd).toBe(true); // året er i gang: kun frem til i dag
    // Manglende data kan accepteres pr. periode og konto (fx en lukket konto).
    const ok = importCoverage(d, { ...later, coverageOk: ['acc-loen'] }, '2027-02-01');
    expect(ok.find((c) => c.accountId === 'acc-loen')!.accepted).toBe(true);
    expect(ok.find((c) => c.accountId === 'acc-ops')!.accepted).toBe(false);
  });
});

describe('bogføringsstart', () => {
  it('also covers periods started before import', () => {
    const d = { ...emptyData(), periods: [{ id: 'p', name: '2025', start: '2025-01-01', end: '2025-12-31' }] };
    expect(withAutoBookStart(d).settings.bookStart).toBe('2024-12-31');
  });
});

describe('depoteksport (UTF-16, tabulator)', () => {
  const rows = [
    ['Id', 'Bogføringsdag', 'Handelsdag', 'Valørdag', 'Depot', 'Transaktionstype', 'Værdipapirer', 'ISIN', 'Antal', 'Kurs', 'Beløb', 'Valuta', 'Saldo', 'Transaktionstekst'],
    ['3', '2025-12-01', '2025-12-01', '2025-12-01', '11112222', 'INDBETALING', '', '', '', '', '2000', 'DKK', '2500', 'Overførsel'],
    ['2', '2025-11-25', '2025-11-25', '2025-11-27', '11112222', 'KØBT', 'Eksempel Global Indeksfond Acc', 'XX0000000001', '10', '150', '-1500', 'DKK', '500', ''],
    ['1', '2025-11-03', '2025-11-03', '2025-11-03', '11112222', 'INDBETALING', '', '', '', '', '2000', 'DKK', '2000', 'Overførsel'],
  ];
  const text = '\ufeff' + rows.map((r) => r.join('\t')).join('\r\n') + '\r\n';
  const utf16le = (s: string) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) & 0xff; b[i * 2 + 1] = s.charCodeAt(i) >> 8; }
    return b.buffer;
  };
  it('decodes UTF-16 and maps broker columns', async () => {
    const { isBrokerSheet } = await import('./csv');
    const decoded = decodeBytes(utf16le(text));
    expect(decoded.startsWith('Id\tBogføringsdag')).toBe(true);
    const sheet = parseCsv(decoded);
    const m = guessMapping(sheet);
    expect(sheet.header[m.date!]).toBe('Bogføringsdag');
    expect(sheet.header[m.amount!]).toBe('Beløb');
    expect(sheet.header[m.balance!]).toBe('Saldo');
    expect(m.text!.map((i) => sheet.header[i])).toEqual(['Transaktionstype', 'Værdipapirer', 'Transaktionstekst']);
    expect(isBrokerSheet(sheet)).toBe(true);
    const { txs } = buildTxs(sheet, m as never, 'acc-depot');
    expect(txs.map((t) => t.text)).toEqual(['INDBETALING · Overførsel', 'KØBT · Eksempel Global Indeksfond Acc', 'INDBETALING · Overførsel']);
    expect(orderChain(txs).breaks).toEqual([]);
  });
  it('decodes UTF-16 without BOM', () => {
    expect(decodeBytes(utf16le('Dato\tBeløb\r\n'))).toBe('Dato\tBeløb\r\n');
  });
});

describe('husket opdeling (regler slået til)', () => {
  it('splits a fixed part off and keeps the rest as income', () => {
    const d0 = demoData();
    const d = { ...d0, settings: { ...d0.settings, rulesEnabled: true } };
    const pay = d.txs.find((t) => t.text === 'Løn Nordlys Design ApS')!;
    const rule = {
      id: 'r-pension', pattern: normalizeText(pay.text), match: 'exact' as const, sign: 'in' as const, createdAt: '',
      then: { type: 'income' as const, categoryId: 'in-loen' },
      splits: [{ cls: { type: 'income' as const, categoryId: 'in-loen' } }, { cls: { type: 'internal' as const, targetAccountId: 'acc-bil' }, amount: 1000_00 }],
    };
    const d2 = { ...d, rules: [rule] };
    const r = resolveAll(d2).get(pay.id)!;
    expect(r.source).toBe('rule');
    expect(r.lines.map((l) => [l.type, l.amount])).toEqual([['income', pay.amount - 100000], ['internal', 100000]]);
    const s = buildEngine(d2).statement(d2.periods[1]);
    const before = buildEngine(d).statement(d.periods[1]);
    const loen = (x: typeof s) => x.income.find((c) => c.id === 'in-loen')!.amount;
    expect(loen(before) - loen(s)).toBe(100000 * 6);
    expect(s.equityClose - s.equityOpen).toBe(s.result + s.openingInPeriod);
    // Med regler slået fra ignoreres reglen.
    expect(resolveAll({ ...d2, settings: { ...d2.settings, rulesEnabled: false } }).get(pay.id)!.source).not.toBe('rule');
  });
});

describe('indbyggede forslag', () => {
  it('never turns MobilePay into udlæg by itself', () => {
    const d = demoData();
    const r = resolveAll(d);
    const mp = d.txs.filter((t) => /MobilePay/.test(t.text));
    expect(mp.length).toBeGreaterThan(0);
    expect(mp.every((t) => r.get(t.id)!.lines[0].type !== 'outlay')).toBe(true);
  });
  it('respects the on/off switches for alias and amount matching', () => {
    const d = demoData();
    const til = d.txs.find((t) => t.text === 'Overførsel til Fælles opsparing')!;
    expect(resolveAll(d).get(til.id)!.source).toBe('alias');
    const off = { ...d, settings: { ...d.settings, autoAlias: false, autoPair: false } };
    const r = resolveAll(off).get(til.id)!;
    expect(['alias', 'pair']).not.toContain(r.source);
  });
});

describe('bankens nøgleord', () => {
  it('matches whole words only and finds the user\'s own category by name', async () => {
    const { BANK_KEYWORD_GUESSES, guessCategory } = await import('./defaults');
    const cats = defaultCategories();
    const hit = (s: string) => { const g = BANK_KEYWORD_GUESSES.find((x) => x.re.test(s)); return g && guessCategory(cats, g); };
    expect(hit('overførsler mobilepay')).toBeUndefined();
    expect(hit('bolig telefon og internet')).toBe('ex-abonnementer');
    expect(hit('shopping tøj')).toBe('ex-beklaedning');
    expect(hit('mad og drikke café')).toBe('ex-spisesteder');
    expect(hit('mad og drikke cafe')).toBe('ex-spisesteder');
    expect(hit('indkomst renter')).toBe('bo-renter-afkast');
  });
});

describe('migrering: udlæg → intern overførsel til personpost', () => {
  it('moves legacy outlays to tracked posts without changing the numbers', async () => {
    const { migrateOutlays, hasLegacyOutlays } = await import('./migrate');
    const { balancesAt } = await import('./ledger');
    const d0 = demoData();
    const jonas = d0.txs.filter((t) => t.text === 'MobilePay Jonas Lind' && !t.manual);
    const legacy = {
      ...d0,
      settings: { ...d0.settings, rulesEnabled: true },
      txs: d0.txs.map((t) => (t.id === jonas[0].id ? { ...t, manual: { type: 'outlay' as const, counterparty: 'Jonas Lind' } } : t)),
      rules: [{ id: 'r-ida', pattern: 'mobilepay ida krogh', match: 'exact' as const, then: { type: 'outlay' as const }, createdAt: '' }],
    };
    expect(hasLegacyOutlays(legacy)).toBe(true);
    const before = buildEngine(legacy);
    const migrated = migrateOutlays(legacy);
    expect(hasLegacyOutlays(migrated)).toBe(false);
    const after = buildEngine(migrated);
    const jAcc = migrated.accounts.find((a) => a.name === 'Jonas Lind')!;
    const iAcc = migrated.accounts.find((a) => a.name === 'Ida Krogh')!;
    expect(jAcc.kind).toBe('tracked');
    expect(iAcc.kind).toBe('tracked');
    // Samme tal som før: egenkapital og personernes saldi
    for (const p of migrated.periods) {
      expect(after.statement(p).equityClose).toBe(before.statement(p).equityClose);
      expect(after.statement(p).result).toBe(before.statement(p).result);
    }
    const end = '2026-06-30';
    expect(balancesAt(after.ledger, end).get(`acc:${jAcc.id}`)).toBe(balancesAt(before.ledger, end).get('cp:jonas lind'));
    expect(balancesAt(after.ledger, end).get(`acc:${iAcc.id}`)).toBe(balancesAt(before.ledger, end).get('cp:ida krogh'));
    // Idempotent
    expect(migrateOutlays(migrated)).toBe(migrated);
  });
});

describe('posttyper og datamodel v2', () => {
  it('turns the old predefined types into the user\'s own types, notes into per-period notes and rules into own choices', async () => {
    const { migrateModel } = await import('./migrate');
    const base = emptyData();
    const old = {
      ...base,
      settings: { ...base.settings, bookStart: '2025-06-30', bookStartSet: true },
      categories: defaultCategories(),
      periods: [{ id: 'p1', name: 'H2', start: '2025-07-01', end: '2025-12-31' }, { id: 'p2', name: 'H1', start: '2026-01-01', end: '2026-06-30' }],
      accounts: [
        { id: 'a', name: 'Lønkonto', kind: 'bank' as const, subtype: 'liquid', side: 'asset' as const, aliases: [] },
        { id: 'b', name: 'Depot', kind: 'valuation' as const, subtype: 'securities', side: 'asset' as const, aliases: [], note: 'Indeksfond' },
        { id: 'c', name: 'Skat', kind: 'tracked' as const, subtype: 'payable', side: 'liability' as const, aliases: [] },
        { id: 'd', name: 'Gammel konto', kind: 'bank' as const, subtype: 'liquid', side: 'asset' as const, aliases: [], archived: true },
      ],
      txs: [{ id: 't1', accountId: 'a', date: '2025-08-01', text: 'Fitness Puls', amount: -27900, seq: 0, importedAt: '' }],
      rules: [{ id: 'r', pattern: 'fitness puls', match: 'exact' as const, then: { type: 'expense' as const, categoryId: 'ex-hobby-sport' }, createdAt: '' }],
    };
    const d = migrateModel({ ...old, settings: { ...old.settings, rulesEnabled: undefined } });
    expect(d.accountTypes.map((t) => t.name)).toEqual(['Likvide midler', 'Værdipapirer']);
    expect(d.accounts.every((a) => a.subtype === undefined)).toBe(true);
    expect(d.accounts.find((a) => a.id === 'c')!.typeId).toBeUndefined(); // "Andet" = ingen type
    expect(d.accounts.find((a) => a.id === 'b')!.notes).toEqual({ p1: 'Indeksfond', p2: 'Indeksfond' });
    expect(d.periods[0].accountIds).toEqual(['a', 'b', 'c']);
    // Reglen er blevet til dit eget valg, og regler er slået fra.
    expect(d.settings.rulesEnabled).toBe(false);
    expect(d.txs[0].manual).toEqual({ type: 'expense', categoryId: 'ex-hobby-sport' });
    expect(resolveAll(d).get('t1')!.source).toBe('manual');
    // Idempotent
    expect(migrateModel(d)).toBe(d);
  });

  it('copies posts and notes from the previous period into a new one', async () => {
    const { withNewPeriod } = await import('./accountTypes');
    const d = demoData();
    const n = withNewPeriod(d, { id: 'p-2027', name: '2027', start: '2027-01-01', end: '2027-12-31' });
    expect(n.periods.find((p) => p.id === 'p-2027')!.accountIds).toEqual(d.periods[1].accountIds);
    expect(n.accounts.find((a) => a.id === 'acc-bil')!.notes!['p-2027']).toBe('Fast rente 4,9 %');
  });

  it('only shows posts in the period\'s list – unless they have a balance', () => {
    const d = demoData();
    const ids = d.periods[1].accountIds!.filter((id) => id !== 'acc-jonas' && id !== 'acc-depot');
    const d2 = { ...d, periods: d.periods.map((p) => (p.id === 'p-2026' ? { ...p, accountIds: ids } : p)) };
    const s = buildEngine(d2).statement(d2.periods[1]);
    expect(s.rows.some((r) => r.ref === 'acc:acc-jonas')).toBe(false); // 0 kr – skjult
    expect(s.rows.some((r) => r.ref === 'acc:acc-depot')).toBe(true); // har en saldo – vises stadig
  });
});

describe('aktiv eller passiv efter fortegn', () => {
  it('places a post by the sign of its balance', () => {
    const d = demoData();
    const d2 = { ...d, openItems: d.openItems.map((o) => ({ ...o, amount: -50000 })) };
    const s = buildEngine(d2).statement(d2.periods[0]);
    const j = s.rows.find((r) => r.ref === 'acc:acc-jonas')!;
    expect(j.side).toBe('liability');
    expect(s.assetsClose - s.liabClose).toBe(s.equityClose);
  });
});

describe('kategorier der går begge veje', () => {
  it('puts a net positive amount under income and a net negative under expense', () => {
    const base = emptyData();
    const mk = (amount: number) => ({
      ...base,
      settings: { ...base.settings, bookStart: '2025-06-30', bookStartSet: true },
      categories: [{ id: 'bo-r', name: 'Renter', kind: 'both' as const }],
      accounts: [{ id: 'a', name: 'Lønkonto', kind: 'bank' as const, side: 'asset' as const, aliases: [] }],
      periods: [{ id: 'p', name: 'H2', start: '2025-07-01', end: '2025-12-31' }],
      txs: [{ id: 't', accountId: 'a', date: '2025-08-01', text: 'Rente', amount, seq: 0, importedAt: '', manual: { type: amount > 0 ? 'income' as const : 'expense' as const, categoryId: 'bo-r' } }],
    });
    const plus = buildEngine(mk(5000)).statement(mk(5000).periods[0]);
    expect(plus.income.map((c) => [c.id, c.amount])).toEqual([['bo-r', 5000]]);
    expect(plus.expense).toEqual([]);
    const minus = buildEngine(mk(-5000)).statement(mk(-5000).periods[0]);
    expect(minus.expense.map((c) => [c.id, c.amount])).toEqual([['bo-r', 5000]]);
    expect(minus.income).toEqual([]);
  });
  it('lets a loan\'s interest land as an expense in the same category', async () => {
    const { valuationResultInPeriod } = await import('./ledger');
    const d = demoData();
    const e = buildEngine(d);
    // Billån 2025: −79.200 → −56.900 med 12 × 2.100 i afdrag ⇒ 2.900 i renter.
    expect(valuationResultInPeriod(d, e.ledger, d.periods[0], 'acc-bil').get('cat:bo-renter-afkast')).toBe(-290000);
  });
});

describe('skift mellem tast selv og følger overførsler', () => {
  it('moves the typed opening value into the start balance – and back', async () => {
    const { switchKind } = await import('./accountTypes');
    const d = demoData();
    const t = switchKind(d, 'acc-depot', 'tracked');
    const start = t.openItems.find((o) => o.accountId === 'acc-depot')!;
    expect(start.amount).toBe(2680000);
    expect(start.date).toBe('2024-12-31');
    expect(buildEngine(t).statement(t.periods[0]).rows.find((r) => r.ref === 'acc:acc-depot')!.open).toBe(2680000);
    const back = switchKind(t, 'acc-depot', 'valuation');
    expect(back.openItems.some((o) => o.accountId === 'acc-depot')).toBe(false);
  });
});

describe('likvide midler uden import', () => {
  it('books transfers to a non-imported cash account directly (not as money in transit)', async () => {
    const { balancesAt } = await import('./ledger');
    const d = demoData();
    const cash = { id: 'acc-kontanter', name: 'Kontanter', kind: 'bank' as const, side: 'asset' as const, aliases: [] };
    const tx = d.txs.find((t) => t.text.startsWith('Kortkøb Café Solsikke'))!;
    const d2 = { ...d, accounts: [...d.accounts, cash], txs: d.txs.map((t) => (t.id === tx.id ? { ...t, manual: { type: 'internal' as const, targetAccountId: cash.id } } : t)) };
    const b = balancesAt(buildEngine(d2).ledger, '2026-06-30');
    expect(b.get('acc:acc-kontanter')).toBe(-tx.amount);
    expect(b.get('transit:acc-kontanter') ?? 0).toBe(0);
  });
});

describe('passive udgifter', () => {
  it('are only passive when marked, and coverage uses them', async () => {
    const { cashflow, isPassive } = await import('./cashflow');
    const d = demoData();
    expect(isPassive(d.categories, 'ex-abonnementer--streaming')).toBe(false);
    const marked = d.categories.map((c) => (c.id === 'ex-bolig' || c.id === 'ex-abonnementer' ? { ...c, passive: true } : c));
    expect(isPassive(marked, 'ex-abonnementer--streaming')).toBe(true); // arver fra hovedkategorien
    const s = buildEngine(d).statement(d.periods[1]);
    const cf = cashflow(s, marked);
    const fixed = (s.expense.find((c) => c.id === 'ex-bolig')?.amount ?? 0) + (s.expense.find((c) => c.id === 'ex-abonnementer')?.amount ?? 0);
    expect(cf.passiveExpense).toBe(fixed);
    expect(cf.passiveCoverage).toBeCloseTo(cf.passive / fixed, 6);
  });
});

describe('kilder til et resultatbeløb', () => {
  it('explains depot return as a valuation change minus transfers', async () => {
    const { plSources, valuationResultInPeriod } = await import('./ledger');
    const d = demoData();
    const e = buildEngine(d);
    const [h2] = d.periods;
    const src = plSources(d, e.ledger, h2, new Set(['cat:bo-renter-afkast']));
    const dep = src.valuations.find((v) => v.accountId === 'acc-depot')!;
    expect(dep.valueTo - dep.valueFrom - dep.transfers).toBe(dep.amount);
    // Afkast 2025 = 35.650 − 26.800 − 4 × 1.500 overførsler = 2.850
    expect(valuationResultInPeriod(d, e.ledger, h2, 'acc-depot').get('cat:bo-renter-afkast')).toBe(285000);
    const groceries = plSources(d, e.ledger, h2, new Set(['cat:ex-dagligvarer']));
    expect(groceries.tx.length).toBeGreaterThan(0);
    expect(-groceries.total).toBe(e.statement(h2).expense.find((c) => c.id === 'ex-dagligvarer')!.amount);
  });
});

describe('kilder til en balancepost', () => {
  it('primo + bevægelser = ultimo for alle poster', async () => {
    const { balanceSources } = await import('./ledger');
    const d = demoData();
    const e = buildEngine(d);
    for (const p of d.periods) {
      for (const row of e.statement(p).rows) {
        const src = balanceSources(e.ledger, row.ref, p);
        expect(src.primo).toBe(row.open);
        expect(src.ultimo).toBe(row.close);
        expect(src.primo + src.moves.reduce((s, m) => s + m.amount, 0)).toBe(src.ultimo);
      }
    }
  });
});

describe('beløbsfelt', () => {
  it('formats while typing', async () => {
    const { formatAmountLive } = await import('../ui/components/common');
    expect(formatAmountLive('1234567')).toBe('1.234.567');
    expect(formatAmountLive('1.2345,6')).toBe('12.345,6');
    expect(formatAmountLive('12345,678')).toBe('12.345,67');
    expect(formatAmountLive('-5000')).toBe('−5.000');
    expect(formatAmountLive(',5')).toBe('0,5');
    expect(formatAmountLive('')).toBe('');
    expect(parseAmount('−12.345,67'.replace('−', '-'))).toBe(-1234567);
  });
});

describe('afstemning af udlæg', () => {
  it('pairs an outlay with repayments and writes off a difference', async () => {
    const { settleState, pairItems, writeOffDifference } = await import('./settle');
    const base = emptyData();
    const d0 = {
      ...base,
      settings: { ...base.settings, bookStart: '2025-06-30', bookStartSet: true },
      categories: [{ id: 'ex-gaver', name: 'Gaver givet', kind: 'expense' as const }],
      accounts: [
        { id: 'a', name: 'Lønkonto', kind: 'bank' as const, side: 'asset' as const, aliases: [] },
        { id: 'v', name: 'Venner skylder mig', kind: 'tracked' as const, side: 'asset' as const, aliases: [] },
      ],
      periods: [{ id: 'p', name: 'H2', start: '2025-07-01', end: '2025-12-31' }],
      txs: [
        { id: 'ud', accountId: 'a', date: '2025-08-01', text: 'Restaurant', amount: -80000, seq: 0, importedAt: '', manual: { type: 'internal' as const, targetAccountId: 'v' } },
        { id: 'j', accountId: 'a', date: '2025-08-03', text: 'MobilePay Jonas', amount: 40000, seq: 1, importedAt: '', manual: { type: 'internal' as const, targetAccountId: 'v' } },
        { id: 'i', accountId: 'a', date: '2025-08-04', text: 'MobilePay Ida', amount: 35000, seq: 2, importedAt: '', manual: { type: 'internal' as const, targetAccountId: 'v' } },
        { id: 'x', accountId: 'a', date: '2025-09-01', text: 'Biograf', amount: -12000, seq: 3, importedAt: '', manual: { type: 'internal' as const, targetAccountId: 'v' } },
        { id: 'y', accountId: 'a', date: '2025-09-02', text: 'MobilePay Jonas', amount: 12000, seq: 4, importedAt: '', manual: { type: 'internal' as const, targetAccountId: 'v' } },
      ],
    };
    let st = settleState(d0, buildEngine(d0).ledger, 'v');
    expect(st.open.map((i) => i.amount)).toEqual([80000, -40000, -35000, 12000, -12000]);
    expect(st.suggestions.map(([a, b]) => [a.key, b.key])).toEqual([['tx:x', 'tx:y']]);
    const d1 = pairItems(pairItems(d0, 'v', ['tx:ud', 'tx:j', 'tx:i']), 'v', ['tx:x', 'tx:y']);
    st = settleState(d1, buildEngine(d1).ledger, 'v');
    expect(st.open).toEqual([]);
    expect(st.groups.map((g) => g.sum)).toEqual([5000, 0]); // Ida betalte 50 kr for lidt
    const g = st.groups[0].match.id;
    const d2 = writeOffDifference(d1, buildEngine(d1).ledger, g, 'ex-gaver');
    const e2 = buildEngine(d2);
    expect(settleState(d2, e2.ledger, 'v').groups.map((x) => x.sum)).toEqual([0, 0]);
    const s = e2.statement(d2.periods[0]);
    expect(s.rows.find((r) => r.ref === 'acc:v')!.close).toBe(0);
    expect(s.expense.find((c) => c.id === 'ex-gaver')!.amount).toBe(5000);
    expect(s.equityClose - s.equityOpen).toBe(s.result + s.openingInPeriod);
  });
});

describe('filtre i Kategorisér', () => {
  it('matches amounts written with comma, dot or thousands separator', async () => {
    const { amountMatches } = await import('./txfilter');
    expect(amountMatches(-24900, '249,00')).toBe(true);
    expect(amountMatches(-24900, '249,0')).toBe(true);
    expect(amountMatches(-24900, '249.00')).toBe(true);
    expect(amountMatches(123450, '1.234,5')).toBe(true);
    expect(amountMatches(123450, '1234,50')).toBe(true);
    expect(amountMatches(123450, '-1234')).toBe(false); // positivt beløb
    expect(amountMatches(-24900, 'netto')).toBe(false);
  });
  it('filters by type, category (incl. subcategories), dates, amount and notes, and sorts', async () => {
    const { filterTxs, DEFAULT } = { ...(await import('./txfilter')), DEFAULT: { q: '', type: 'all' as const, status: 'all' as const, withNote: false, sort: 'date-asc' as const } };
    const d = demoData();
    const e = buildEngine(d);
    const f = (patch: object) => filterTxs(d.txs, e.resolved, d.categories, { ...DEFAULT, ...patch });
    expect(f({ categoryId: 'ex-bolig' }).every((t) => /Husleje|Lysværket|Fiberby|Mobilselskabet/.test(t.text) || e.resolved.get(t.id)!.lines.some((l) => l.categoryId?.startsWith('ex-bolig')))).toBe(true);
    expect(f({ type: 'internal' }).length).toBeGreaterThan(0);
    expect(f({ from: '2026-01-01', to: '2026-01-31' }).every((t) => t.date.startsWith('2026-01'))).toBe(true);
    expect(f({ min: '8.000', max: '9.000' }).every((t) => Math.abs(t.amount) >= 800000 && Math.abs(t.amount) <= 900000)).toBe(true);
    expect(f({ withNote: true }).map((t) => t.text)).toEqual(['MobilePay Jonas Lind']);
    const desc = f({ sort: 'amount-desc' });
    expect(Math.abs(desc[0].amount)).toBeGreaterThanOrEqual(Math.abs(desc[desc.length - 1].amount));
  });
});

describe('importerede filer', () => {
  it('lists files and removes one without touching transactions another file also contains', async () => {
    const { importFiles, removeImport } = await import('./imports');
    const d = demoData();
    const files = importFiles(d);
    expect(files.map((f) => f.fileName).sort()).toEqual(['lonkonto-2025-01_2026-06.csv', 'opsparing-2025-01_2026-06.csv']);
    const loen = files.find((f) => f.accountId === 'acc-loen')!;
    // En anden fil med overlap: de første 10 transaktioner
    const overlap = { id: 'imp-x', fileName: 'overlap.csv', accountId: 'acc-loen', importedAt: '2026-08-01T00:00:00Z', txIds: loen.txs.slice(0, 10).map((t) => t.id) };
    const d2 = { ...d, imports: [...d.imports, overlap] };
    const after = removeImport(d2, loen.id);
    expect(after.txs.filter((t) => t.accountId === 'acc-loen').map((t) => t.id).sort()).toEqual(overlap.txIds.sort());
    expect(after.imports.map((r) => r.id)).not.toContain(loen.id);
    // Ældre data uden filregistrering vises som "Tidligere import"
    expect(importFiles({ ...d, imports: [] }).every((f) => f.legacy)).toBe(true);
  });
});

describe('årlige financial statements', () => {
  it('shows a half year as a slice of the year – same bookkeeping, and the halves add up', async () => {
    const { scoped, compareFor, compareOptions, elapsedEnd, scopeAvailable } = await import('./periods');
    const d = demoData();
    const e = buildEngine(d);
    const [y25, y26] = d.periods;
    const h1 = scoped(y25, 'h1');
    const h2 = scoped(y25, 'h2');
    expect([h1.start, h1.end, h2.start, h2.end]).toEqual(['2025-01-01', '2025-06-30', '2025-07-01', '2025-12-31']);
    expect(h1.id).toBe(y25.id); // kommentarer og poster følger året
    const [a, b, year] = [e.statement(h1), e.statement(h2), e.statement(y25)];
    expect(a.result + b.result).toBe(year.result);
    expect(a.equityClose).toBe(b.equityOpen);
    // Depotet har en værdi pr. 30.06, så afkastet fordeles på halvårene.
    expect(a.rows.find((r) => r.ref === 'acc:acc-depot')!.close).toBe(3100000);
    // Sammenligning: 2. halvår ↔ 1. halvår · 1. halvår ↔ 2. halvår året før · året ↔ året før.
    expect(compareFor(d, y25, 'h2')!.end).toBe('2025-06-30');
    expect([compareFor(d, y26, 'h1')!.start, compareFor(d, y26, 'h1')!.end]).toEqual(['2025-07-01', '2025-12-31']);
    expect(compareFor(d, y26, 'year')!.id).toBe('p-2025');
    expect(compareFor({ ...d, periods: d.periods.map((p) => (p.id === 'p-2026' ? { ...p, compareToId: 'p-2025#h1' } : p)) }, { ...y26, compareToId: 'p-2025#h1' }, 'h1')!.end).toBe('2025-06-30');
    expect(compareOptions(d, y26, 'h1').map((o) => o.id)).toEqual(['p-2026', 'p-2026#h2', 'p-2025', 'p-2025#h1', 'p-2025#h2']);
    // Et igangværende år: gennemsnit og dækning frem til i dag; 2. halvår først, når det er begyndt.
    expect(elapsedEnd(y26, '2026-11-10')).toBe('2026-11-10');
    expect(elapsedEnd(y25, '2026-11-10')).toBe('2025-12-31');
    expect(scopeAvailable(y26, 'h2', '2026-05-01')).toBe(false);
  });

  it('merges old half-year statements into years (posts, notes, slides and comparisons follow)', async () => {
    const { migratePeriods } = await import('./migrate');
    const base = emptyData();
    const acc = { id: 'a', name: 'Depot', kind: 'valuation' as const, side: 'asset' as const, aliases: [], notes: { h1: 'gammel', h2: 'ny' } };
    const d = migratePeriods({
      ...base,
      accounts: [acc, { ...acc, id: 'b', notes: { x: 'næste år' } }],
      periods: [
        { id: 'h1', name: '2025 H1', start: '2025-01-01', end: '2025-06-30', accountIds: ['a'], coverageOk: ['a'] },
        { id: 'h2', name: '2025 H2', start: '2025-07-01', end: '2025-12-31', accountIds: ['b'], balanceConfirmed: true },
        { id: 'x', name: 'Første halvår 2026 H1', start: '2026-01-01', end: '2026-06-30', compareToId: 'h1' },
      ],
      slideNotes: { h1: { title: 'Forår' }, x: { title: 'Nu' } },
    });
    expect(d.periods.map((p) => [p.id, p.name, p.start, p.end, p.show ?? 'year'])).toEqual([
      ['h2', '2025', '2025-01-01', '2025-12-31', 'year'],
      ['x', 'Første halvår 2026', '2026-01-01', '2026-12-31', 'h1'],
    ]);
    const y25 = d.periods[0];
    expect([y25.accountIds, y25.coverageOk, y25.balanceConfirmed]).toEqual([['b', 'a'], ['a'], true]);
    expect(d.periods[1].compareToId).toBe('h2#h1');
    expect(d.accounts[0].notes).toEqual({ h2: 'ny' }); // den seneste kommentar vinder
    expect(d.slideNotes).toEqual({ 'h2#h1': { title: 'Forår' }, 'x#h1': { title: 'Nu' } });
    expect(migratePeriods(d)).toBe(d);
  });
});

describe('underkategorier i flere niveauer', () => {
  it('sums the whole subtree, keeps own postings apart, and filters/inherits through all levels', async () => {
    const { filterTxs } = await import('./txfilter');
    const { isPassive } = await import('./cashflow');
    const { categoryPath, descendants } = await import('./categories');
    const base = emptyData();
    const categories = [
      { id: 'ex-bolig', name: 'Bolig', kind: 'expense' as const, passive: true },
      { id: 'ex-bolig--el', name: 'El & varme', kind: 'expense' as const, parentId: 'ex-bolig' },
      { id: 'ex-bolig--el--varme', name: 'Varme', kind: 'expense' as const, parentId: 'ex-bolig--el' },
    ];
    const tx = (id: string, amount: number, categoryId: string) => ({ id, accountId: 'a', date: '2025-03-01', text: id, amount, seq: 0, importedAt: '', manual: { type: 'expense' as const, categoryId } });
    const d = {
      ...base,
      settings: { ...base.settings, bookStart: '2024-12-31', bookStartSet: true },
      categories,
      accounts: [{ id: 'a', name: 'Lønkonto', kind: 'bank' as const, side: 'asset' as const, aliases: [] }],
      periods: [{ id: 'p', name: '2025', start: '2025-01-01', end: '2025-12-31' }],
      txs: [tx('t1', -30000, 'ex-bolig--el--varme'), tx('t2', -10000, 'ex-bolig--el'), tx('t3', -5000, 'ex-bolig')],
    };
    const e = buildEngine(d);
    const bolig = e.statement(d.periods[0]).expense[0];
    expect(bolig.amount).toBe(45000);
    const el = bolig.children.find((c) => c.id === 'ex-bolig--el')!;
    expect(el.amount).toBe(40000);
    expect(el.children.map((c) => [c.id, c.amount])).toEqual([['ex-bolig--el--varme', 30000], ['ex-bolig--el#own', 10000]]);
    expect(bolig.children.find((c) => c.own)!.amount).toBe(5000);
    expect(el.cats.sort()).toEqual(['ex-bolig--el', 'ex-bolig--el--varme']);
    expect(categoryPath(categories, 'ex-bolig--el--varme')).toBe('Bolig › El & varme › Varme');
    expect(descendants(categories, 'ex-bolig')).toHaveLength(3);
    expect(isPassive(categories, 'ex-bolig--el--varme')).toBe(true); // arver fra Bolig to niveauer oppe
    const f = { q: '', type: 'all' as const, status: 'all' as const, withNote: false, sort: 'date-asc' as const, categoryId: 'ex-bolig--el' };
    expect(filterTxs(d.txs, e.resolved, categories, f).map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });
});

describe('opdeling større end beløbet', () => {
  it('lets the rest go the other way (an expense whose rest becomes income) and still balances', () => {
    const d = demoData();
    const tx = d.txs.find((t) => t.text.startsWith('Kortkøb Café Solsikke') && t.date >= '2025-01-01')!;
    const out = -tx.amount; // fx 100 kr ud
    const splits = [
      { type: 'income' as const, categoryId: 'in-diverse-indtaegter', amount: 5000 },
      { type: 'internal' as const, targetAccountId: 'acc-jonas', amount: -(out + 5000) },
    ];
    const d2 = { ...d, txs: d.txs.map((t) => (t.id === tx.id ? { ...t, splits } : t)) };
    const e = buildEngine(d2);
    expect(e.resolved.get(tx.id)!.lines.map((l) => l.amount)).toEqual([5000, -(out + 5000)]);
    const s = e.statement(d2.periods[0]);
    expect(s.income.find((c) => c.id === 'in-diverse-indtaegter')!.amount).toBe(5000);
    expect(s.equityClose - s.equityOpen).toBe(s.result + s.openingInPeriod);
  });
});

describe('periode for en importeret fil', () => {
  it('counts quiet days at the end of the export as covered', async () => {
    const { importCoverage } = await import('./engine');
    const { setImportRange, importFiles } = await import('./imports');
    const d = demoData();
    const later = { id: 'x', name: '2026', start: '2026-01-01', end: '2026-12-31' };
    expect(importCoverage(d, later, '2026-08-15').find((c) => c.accountId === 'acc-loen')!.coversEnd).toBe(false);
    const d2 = setImportRange(d, 'imp-acc-loen', '2025-01-01', '2026-08-10');
    expect(importCoverage(d2, later, '2026-08-15').find((c) => c.accountId === 'acc-loen')!.coversEnd).toBe(true);
    const f = importFiles(d2).find((x) => x.id === 'imp-acc-loen')!;
    expect([f.from, f.to, f.declared]).toEqual(['2025-01-01', '2026-08-10', true]);
    expect(importFiles(d).find((x) => x.id === 'imp-acc-loen')!.declared).toBe(false);
  });
});

describe('egne parringer af interne overførsler', () => {
  it('pairs manually across more than a week, and an undone auto pair stays undone', () => {
    const d = demoData();
    const out = d.txs.find((t) => t.text === 'Overførsel til Fælles opsparing' && t.date === '2025-03-10')!;
    const inn = d.txs.find((t) => t.text === 'Overførsel fra Lønkonto' && t.date === '2025-03-10')!;
    expect(resolveAll(d).get(out.id)!.pairId).toBe(inn.id);
    // Ophæv den automatiske parring
    const undone = { ...d, txs: d.txs.map((t) => (t.id === out.id || t.id === inn.id ? { ...t, noAutoPair: true } : t)) };
    expect(resolveAll(undone).get(out.id)!.pairId).toBeUndefined();
    // Par manuelt med en modpost en måned senere
    const later = d.txs.find((t) => t.text === 'Overførsel fra Lønkonto' && t.date === '2025-04-10')!;
    const man = { ...undone, txs: undone.txs.map((t) => (t.id === out.id ? { ...t, pairWith: later.id, manual: { type: 'internal' as const, targetAccountId: 'acc-ops' } } : t.id === later.id ? { ...t, pairWith: out.id, manual: { type: 'internal' as const, targetAccountId: 'acc-loen' } } : t)) };
    const r = resolveAll(man);
    expect(r.get(out.id)!.pairId).toBe(later.id);
    expect(r.get(later.id)!.pairId).toBe(out.id);
  });
});

describe('afstemning holder sig til perioden', () => {
  it('shows only the period\'s movements plus one "saldo primo" line, and ignores groups across periods', async () => {
    const { settleState, primoKey, pairItems } = await import('./settle');
    const d = demoData();
    const e = buildEngine(d);
    const [y25, y26] = d.periods;
    const s25 = settleState(d, e.ledger, 'acc-jonas', y25);
    // Startsaldoen (fra før 2025) står som saldo primo; tilbagebetalingen i august er periodens eneste bevægelse.
    expect(s25.items.map((i) => [i.key.split(':')[0], i.amount])).toEqual([['primo', 20000], ['tx', -20000]]);
    expect(s25.suggestions).toHaveLength(1);
    // 2026: intet fra 2025 dukker op.
    expect(settleState(d, e.ledger, 'acc-jonas', y26).items).toEqual([]);
    // Par saldo primo med tilbagebetalingen → gruppen går op i 2025.
    const d2 = pairItems(d, 'acc-jonas', s25.items.map((i) => i.key));
    expect(settleState(d2, e.ledger, 'acc-jonas', y25).groups.map((g) => g.sum)).toEqual([0]);
    expect(d2.matches[0].keys[0]).toBe(primoKey(y25));
    // En gruppe på tværs af perioder vises ikke – bevægelserne står som uparrede i begge perioder.
    const mp26 = d.txs.find((t) => t.text === 'MobilePay Jonas Lind' && t.date >= '2026-01-01')!;
    const d3 = { ...d, txs: d.txs.map((t) => (t.id === mp26.id ? { ...t, manual: { type: 'internal' as const, targetAccountId: 'acc-jonas' } } : t)) };
    const e3 = buildEngine(d3);
    const cross = { ...d3, matches: [{ id: 'm', accountId: 'acc-jonas', keys: [s25.items[1].key, `tx:${mp26.id}`] }] };
    expect(settleState(cross, e3.ledger, 'acc-jonas', y25).groups).toEqual([]);
    expect(settleState(cross, e3.ledger, 'acc-jonas', y25).open.map((i) => i.key)).toContain(s25.items[1].key);
    expect(settleState(cross, e3.ledger, 'acc-jonas', y26).items.map((i) => i.key)).toEqual([`tx:${mp26.id}`]);
    expect(settleState(cross, e3.ledger, 'acc-jonas', y26).groups).toEqual([]);
  });
});

describe('hører sammen', () => {
  it('links, merges and unlinks transactions without touching the accounts', async () => {
    const { linkTxs, unlinkTx, linkedWith } = await import('./links');
    const d = demoData();
    const [a, b, c, x] = d.txs;
    let n = linkTxs(d, a.id, b.id);
    n = linkTxs(n, c.id, x.id);
    n = linkTxs(n, b.id, c.id); // to grupper lægges sammen
    const get = (id: string) => n.txs.find((t) => t.id === id)!;
    expect(linkedWith(n.txs, get(a.id)).map((t) => t.id).sort()).toEqual([b.id, c.id, x.id].sort());
    n = unlinkTx(n, a.id);
    expect(get(a.id).link).toBeUndefined();
    expect(linkedWith(n.txs, get(b.id))).toHaveLength(2);
    const two = unlinkTx(unlinkTx(n, b.id), c.id); // kun x tilbage → gruppen opløses
    expect(two.txs.find((t) => t.id === x.id)!.link).toBeUndefined();
    const s0 = buildEngine(d).statement(d.periods[0]), s1 = buildEngine(n).statement(n.periods[0]);
    expect(s1.result).toBe(s0.result);
  });
});

describe('indbetaling fra penge undervejs', () => {
  it('books an incoming payment against money in transit from an earlier period – not as income, not paired', async () => {
    const { transferInfo } = await import('./transfers');
    const d0 = demoData();
    // 1.500 kr var undervejs ved bogføringsstart (ukendt modtager) og lander som en indbetaling i januar.
    const inn = d0.txs.find((t) => t.amount > 0 && t.date >= '2025-01-01' && t.text.startsWith('Faktura'))!;
    const d = { ...d0, settings: { ...d0.settings, openingTransit: inn.amount }, txs: d0.txs.map((t) => (t.id === inn.id ? { ...t, manual: { type: 'internal' as const, transitRef: 'transit' } } : t)) };
    const e = buildEngine(d);
    const s = e.statement(d.periods[0]);
    expect(s.rows.find((r) => r.ref === 'transit')).toMatchObject({ open: inn.amount, close: 0 });
    const before = buildEngine({ ...d0, settings: { ...d0.settings, openingTransit: inn.amount } }).statement(d0.periods[0]);
    expect(before.result - s.result).toBe(inn.amount); // ikke længere en indtægt
    expect(s.equityClose - s.equityOpen).toBe(s.result + s.openingInPeriod);
    expect(e.resolved.get(inn.id)!.pairId).toBeUndefined();
    expect(transferInfo(d, e.resolved, e.txById, inn, d.periods[0])).toMatchObject({ kind: 'direct', transitRef: 'transit' });
  });
});

describe('penge undervejs fra forrige periode', () => {
  it('shows what landed automatically, what you chose, and what is still missing', async () => {
    const { carriedTransit, transitCandidates } = await import('./transfers');
    const d0 = demoData();
    const e0 = buildEngine(d0);
    // 2026: nytårsoverførslen (6.000 til Fælles opsparing) landede 02.01 – automatisk.
    const [c26] = carriedTransit(d0, e0.ledger, e0.resolved, d0.periods[1]);
    expect([c26.ref, c26.primo, c26.remaining, c26.landed.length, c26.landed[0].chosen]).toEqual(['transit:acc-ops', 600000, 0, 1, false]);
    // 2025: 3.800 kr undervejs ved bogføringsstart (ukendt modtager) – mangler, indtil du vælger indbetalingen.
    const d = { ...d0, settings: { ...d0.settings, openingTransit: 380000 } };
    const e = buildEngine(d);
    const [c] = carriedTransit(d, e.ledger, e.resolved, d.periods[0]);
    expect([c.ref, c.remaining, c.landed]).toEqual(['transit', 380000, []]);
    const cand = transitCandidates(d, e.resolved, d.periods[0], c);
    expect(cand[0].amount).toBe(380000); // samme beløb først
    const d2 = { ...d, txs: d.txs.map((t) => (t.id === cand[0].id ? { ...t, manual: { type: 'internal' as const, transitRef: 'transit' } } : t)) };
    const e2 = buildEngine(d2);
    const [c2] = carriedTransit(d2, e2.ledger, e2.resolved, d2.periods[0]);
    expect([c2.remaining, c2.landed.map((x) => [x.tx.id, x.chosen])]).toEqual([0, [[cand[0].id, true]]]);
  });
});

describe('flyt kategorier', () => {
  it('reorders siblings, moves under another parent, and refuses cycles or other kinds', async () => {
    const { moveCategory, childrenOf } = await import('./categories');
    const cats = defaultCategories();
    const names = (cs: typeof cats, parent?: string) => childrenOf(cs, parent).filter((c) => c.kind === 'expense').map((c) => c.name);
    // Dagligvarer foran Bolig
    let m = moveCategory(cats, 'ex-dagligvarer', { before: 'ex-bolig' });
    expect(names(m).slice(0, 2)).toEqual(['Dagligvarer', 'Bolig']);
    // Spisesteder ind under Dagligvarer (sidst)
    m = moveCategory(m, 'ex-spisesteder', { parentId: 'ex-dagligvarer' });
    expect(names(m, 'ex-dagligvarer')).toEqual(['Spisesteder']);
    // Tilbage til øverste niveau
    expect(moveCategory(m, 'ex-spisesteder', { parentId: null }).find((c) => c.id === 'ex-spisesteder')!.parentId).toBeUndefined();
    // Ikke ind under sig selv / sin egen underkategori, og ikke over i en anden slags
    expect(moveCategory(m, 'ex-dagligvarer', { parentId: 'ex-spisesteder' })).toBe(m);
    expect(moveCategory(m, 'ex-bolig', { before: 'in-loen' })).toBe(m);
  });
});

describe('afstemning af transaktioner, der hører sammen', () => {
  it('shows the difference, lets you write it off, and asks again if the group changes', async () => {
    const { linkTxs, linkGroups, acceptLinkDifference } = await import('./links');
    const d0 = demoData();
    const buy = d0.txs.find((t) => t.text.includes('Restaurant Havnehuset') && t.date === '2025-04-14')!;
    const back = d0.txs.find((t) => t.text === 'MobilePay Jonas Lind' && t.date === '2025-04-15')!;
    let d = linkTxs(d0, buy.id, back.id);
    let [g] = linkGroups(d, d.periods[0]);
    expect([g.sum, g.accepted]).toEqual([buy.amount + back.amount, false]);
    expect(linkGroups(d, d.periods[1])).toEqual([]); // kun perioden
    d = acceptLinkDifference(d, g.id, true, 'Jonas gav resten');
    [g] = linkGroups(d, d.periods[0]);
    expect([g.accepted, g.note]).toEqual([true, 'Jonas gav resten']);
    // En ny transaktion i gruppen ændrer summen → skal godkendes igen
    const extra = d0.txs.find((t) => t.text === 'MobilePay Jonas Lind' && t.date === '2025-07-15')!;
    d = linkTxs(d, buy.id, extra.id);
    expect(linkGroups(d, d.periods[0])[0].accepted).toBe(false);
    // Regnskabet påvirkes ikke
    expect(buildEngine(d).statement(d.periods[0]).result).toBe(buildEngine(d0).statement(d0.periods[0]).result);
  });
});

describe('afstemning pr. periode', () => {
  it('is chosen per financial statement, and old per-post choices are migrated to the periods where they were used', async () => {
    const { isSettled, withSettle } = await import('./settle');
    const { migrateSettle } = await import('./migrate');
    const d0 = demoData();
    const jonas = d0.accounts.find((a) => a.id === 'acc-jonas')!;
    const d = withSettle(d0, 'p-2025', 'acc-jonas', true);
    const [y25, y26] = d.periods;
    expect([isSettled(y25, jonas), isSettled(y26, jonas)]).toEqual([true, false]);
    expect(isSettled(withSettle(d, 'p-2025', 'acc-jonas', false).periods[0], jonas)).toBe(false);
    // Ældre data: valget lå på posten (alle perioder)
    const legacyAll = migrateSettle({ ...d0, accounts: d0.accounts.map((a) => (a.id === 'acc-jonas' ? { ...a, settle: true } : a)) });
    expect(legacyAll.periods.map((p) => p.settle)).toEqual([['acc-jonas'], ['acc-jonas']]);
    expect(legacyAll.accounts.find((a) => a.id === 'acc-jonas')!.settle).toBeUndefined();
    expect(migrateSettle(legacyAll)).toBe(legacyAll);
    // Intet valg, men parringer i 2025 → kun med i 2025
    const repay = d0.txs.find((t) => t.text === 'MobilePay Jonas Lind' && t.date === '2025-08-20')!;
    const inferred = migrateSettle({ ...d0, matches: [{ id: 'm', accountId: 'acc-jonas', keys: ['primo:2025-01-01', `tx:${repay.id}`] }] });
    expect(inferred.periods.map((p) => p.settle)).toEqual([['acc-jonas'], []]);
  });
});

describe('ingen parring alene', () => {
  it('dissolves a group when only one movement is left', async () => {
    const { pairItems, unpair, settleState } = await import('./settle');
    const { linkTxs, unlinkTx } = await import('./links');
    const d0 = demoData();
    const [a, b] = d0.txs;
    let d = pairItems(d0, 'acc-jonas', [`tx:${a.id}`, `tx:${b.id}`]);
    expect(d.matches).toHaveLength(1);
    d = unpair(d, d.matches[0].id, `tx:${a.id}`);
    expect(d.matches).toEqual([]); // b står ikke parret alene
    // Flyttes den ene til en anden gruppe, opløses den gamle, hvis kun én er tilbage
    const c = d0.txs[2];
    d = pairItems(d0, 'acc-jonas', [`tx:${a.id}`, `tx:${b.id}`]);
    d = pairItems(d, 'acc-jonas', [`tx:${b.id}`, `tx:${c.id}`]);
    expect(d.matches.map((m) => m.keys.length)).toEqual([2]);
    // En gruppe, hvor den anden er slettet, tæller ikke som parret
    const gone = { ...d0, matches: [{ id: 'm', accountId: 'acc-jonas', keys: ['tx:findes-ikke', `tx:${d0.txs.find((t) => t.date === '2025-08-20' && t.text === 'MobilePay Jonas Lind')!.id}`] }] };
    expect(settleState(gone, buildEngine(gone).ledger, 'acc-jonas', gone.periods[0]).groups).toEqual([]);
    // Hører-sammen/parrede transaktioner: den sidste mister også sin parring
    let l = linkTxs(d0, a.id, b.id);
    l = unlinkTx(l, a.id);
    expect(l.txs.filter((t) => t.link)).toEqual([]);
  });
});

describe('afskrevet difference følger gruppen', () => {
  const setup = async () => {
    const { pairItems, writeOffDifference } = await import('./settle');
    const d0 = demoData();
    const buy = d0.txs.find((t) => t.text.includes('Restaurant Havnehuset') && t.date === '2025-04-14')!;
    const back = d0.txs.find((t) => t.text === 'MobilePay Jonas Lind' && t.date === '2025-04-15')!;
    let d = { ...d0, txs: d0.txs.map((t) => (t.id === buy.id || t.id === back.id ? { ...t, manual: { type: 'internal' as const, targetAccountId: 'acc-jonas' } } : t)) };
    d = pairItems(d, 'acc-jonas', [`tx:${buy.id}`, `tx:${back.id}`]);
    d = writeOffDifference(d, buildEngine(d).ledger, d.matches[0].id, 'ex-gaver-givet', d.periods[0]);
    return { d, d0, buy, back };
  };
  const jonasClose = (d: ReturnType<typeof demoData>) => buildEngine(d).statement(d.periods[0]).rows.find((r) => r.ref === 'acc:acc-jonas')?.close ?? 0;

  it('removes the write-off when the group is dissolved', async () => {
    const { unpair } = await import('./settle');
    const { d } = await setup();
    expect(d.openItems.some((o) => o.note === 'Afskrevet difference')).toBe(true);
    const n = unpair(d, d.matches[0].id);
    expect(n.matches).toEqual([]);
    expect(n.openItems.some((o) => o.note === 'Afskrevet difference')).toBe(false);
    // Jonas skylder nu de 800 igen – afskrivningen står ikke tilbage som et beløb
    expect(jonasClose(n)).toBe(80000);
  });

  it('dissolves the group (with its write-off) when one of two movements is taken out', async () => {
    const { unpair } = await import('./settle');
    const { d, buy } = await setup();
    const n = unpair(d, d.matches[0].id, `tx:${buy.id}`);
    expect(n.matches).toEqual([]); // den anden står ikke alene med afskrivningen
    expect(n.openItems.some((o) => o.note === 'Afskrevet difference')).toBe(false);
  });

  it('also when the movement is reclassified away from the post, and cleans up old leftovers on load', async () => {
    const { removeFromMatches, tidySettle } = await import('./settle');
    const { d, back } = await setup();
    const n = removeFromMatches(d, [`tx:${back.id}`]);
    expect([n.matches.length, n.openItems.filter((o) => o.note === 'Afskrevet difference').length]).toEqual([0, 0]);
    // Gamle data: afskrivningen blev stående, efter gruppen var slettet
    const leftover = { ...d, matches: [] };
    const cleaned = tidySettle(leftover);
    expect(cleaned.openItems.some((o) => o.note === 'Afskrevet difference')).toBe(false);
    expect(tidySettle(cleaned)).toBe(cleaned);
  });
});

describe('afklar resten: afskriv eller tag med til næste periode', () => {
  it('writes off a single movement, or carries it forward so it shows up in the next year primo', async () => {
    const { settleState, withSettle, withCarry, writeOffItem, unpair } = await import('./settle');
    const { periodChecks } = await import('./engine');
    const d0 = demoData();
    const buy = d0.txs.find((t) => t.text.includes('Restaurant Havnehuset') && t.date === '2025-10-14')!;
    let d = { ...d0, txs: d0.txs.map((t) => (t.id === buy.id ? { ...t, manual: { type: 'internal' as const, targetAccountId: 'acc-jonas' } } : t)) };
    d = withSettle(d, 'p-2025', 'acc-jonas', true);
    const y25 = () => d.periods[0];
    let st = settleState(d, buildEngine(d).ledger, 'acc-jonas', y25());
    // primo 200 ↔ 20.08 −200 er uparrede, og restaurantudlægget 1.200
    expect(st.done).toBe(false);
    expect(periodChecks(buildEngine(d), y25()).find((c) => c.id === 'settle-acc-jonas')?.level).toBe('warn');
    // Tag udlægget med til 2026
    d = withCarry(d, 'p-2025', `tx:${buy.id}`, true);
    st = settleState(d, buildEngine(d).ledger, 'acc-jonas', y25());
    expect(st.carriedSum).toBe(120000);
    expect(st.pending.map((i) => i.key)).not.toContain(`tx:${buy.id}`);
    // Saldo primo 2026 indeholder det videreførte beløb
    const st26 = settleState(d, buildEngine(d).ledger, 'acc-jonas', d.periods[1]);
    expect(st26.items.find((i) => i.primo)?.amount).toBe(120000);
    // Afskriv i stedet: posten går i 0 for udlægget, og en afskrivning, der fjernes, tager gruppen med sig
    d = withCarry(d, 'p-2025', `tx:${buy.id}`, false);
    d = writeOffItem(d, buildEngine(d).ledger, 'acc-jonas', `tx:${buy.id}`, 'ex-gaver-givet', y25());
    st = settleState(d, buildEngine(d).ledger, 'acc-jonas', y25());
    const g = st.groups.find((x) => x.items.some((i) => i.key === `tx:${buy.id}`))!;
    expect(g.sum).toBe(0);
    const undone = unpair(d, g.match.id);
    expect(undone.openItems.some((o) => o.note === 'Afskrevet')).toBe(false);
    // Par primo med tilbagebetalingen → alt afklaret
    const keys = st.pending.map((i) => i.key);
    const { pairItems } = await import('./settle');
    d = pairItems(d, 'acc-jonas', keys);
    expect(settleState(d, buildEngine(d).ledger, 'acc-jonas', y25()).done).toBe(true);
    expect(periodChecks(buildEngine(d), y25()).find((c) => c.id === 'settle-acc-jonas')?.level).toBe('ok');
  });
});

describe('tag stilling til en post: afskriv eller lad stå', () => {
  it('lets the remaining stand as an asset, or writes all of it off', async () => {
    const { settleState, withSettle, settleRemaining, undoStand } = await import('./settle');
    const d0 = demoData();
    const buy = d0.txs.find((t) => t.text.includes('Restaurant Havnehuset') && t.date === '2025-10-14')!;
    let d = { ...d0, txs: d0.txs.map((t) => (t.id === buy.id ? { ...t, manual: { type: 'internal' as const, targetAccountId: 'acc-jonas' } } : t)) };
    d = withSettle(d, 'p-2025', 'acc-jonas', true);
    const st = () => settleState(d, buildEngine(d).ledger, 'acc-jonas', d.periods[0]);
    expect(st().done).toBe(false);
    // Lad stå: alt afklaret, og beløbet (primo 200 − 200 + 1.200) står som aktiv
    const stood = settleRemaining(d, buildEngine(d).ledger, 'acc-jonas', d.periods[0], { stand: true });
    const s1 = settleState(stood, buildEngine(stood).ledger, 'acc-jonas', stood.periods[0]);
    expect([s1.done, s1.carriedSum]).toEqual([true, 120000]);
    const back = undoStand(stood, buildEngine(stood).ledger, 'acc-jonas', stood.periods[0]);
    expect(settleState(back, buildEngine(back).ledger, 'acc-jonas', back.periods[0]).done).toBe(false);
    // Afskriv: alt afklaret, og posten står i 0
    d = settleRemaining(d, buildEngine(d).ledger, 'acc-jonas', d.periods[0], { writeOff: 'ex-gaver-givet' });
    const s2 = st();
    expect([s2.done, s2.carriedSum]).toEqual([true, 0]);
    expect(buildEngine(d).statement(d.periods[0]).rows.find((r) => r.ref === 'acc:acc-jonas')?.close ?? 0).toBe(0);
  });
});
