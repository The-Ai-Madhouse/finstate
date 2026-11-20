import { describe, expect, it } from 'vitest';
import { applyBackup, makeBackup } from './backup';
import { resolveAll } from './classify';
import { demoData } from './demo';
import { emptyData } from './defaults';
import {
  addMonthsKeepDay, budgetItems, detectSubscriptions, nextOccurrence, occurrencesBetween, paidTx, removeSubscription,
  resetSubscription, restoreSubscription, saveSubscription, subName,
} from './subscriptions';
import type { AppData, Tx } from './types';

const tx = (id: string, date: string, text: string, amount: number, accountId = 'acc-a'): Tx =>
  ({ id, accountId, date, text, amount, seq: 0, importedAt: '2026-01-01' });

function data(txs: Tx[]): AppData {
  return { ...emptyData(), accounts: [{ id: 'acc-a', name: 'Lønkonto', kind: 'bank', side: 'asset', aliases: [] }], txs };
}
const monthly = (prefix: string, text: string, amount: number, day: number, n = 6, from = '2026-01') =>
  [...Array(n)].map((_, i) => tx(`${prefix}${i}`, addMonthsKeepDay(`${from}-${String(day).padStart(2, '0')}`, i), text, amount));

describe('datoer', () => {
  it('keeps the day of month and clamps to short months', () => {
    expect(addMonthsKeepDay('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsKeepDay('2026-11-15', 2)).toBe('2027-01-15');
    expect(addMonthsKeepDay('2026-03-10', -3)).toBe('2025-12-10');
  });
  it('lists occurrences in a range and finds the next one', () => {
    expect(occurrencesBetween('2026-01-05', 'monthly', '2026-03-01', '2026-05-31')).toEqual(['2026-03-05', '2026-04-05', '2026-05-05']);
    expect(occurrencesBetween('2025-07-10', 'halfyear', '2026-01-01', '2026-12-31')).toEqual(['2026-01-10', '2026-07-10']);
    expect(nextOccurrence('2026-06-06', 'monthly', '2026-11-20')).toBe('2026-12-06');
    expect(nextOccurrence('2026-06-06', 'yearly', '2026-06-06')).toBe('2026-06-06');
  });
});

describe('genkendelse af abonnementer', () => {
  it('finds monthly subscriptions and ignores groceries and one-offs', () => {
    const d = data([
      ...monthly('s', 'Streamio abonnement 1234', -119_00, 6),
      ...[...Array(24)].map((_, i) => tx(`g${i}`, `2026-0${1 + Math.floor(i / 4)}-${String(3 + (i % 4) * 7).padStart(2, '0')}`, 'Kortkøb Købmand Hansen', -(300_00 + i * 731))),
      tx('x', '2026-03-03', 'Kortkøb Tøjhuset', -699_00),
    ]);
    const found = detectSubscriptions(d, resolveAll(d));
    expect(found.map((f) => [f.name, f.cadence, f.amount])).toEqual([['Streamio', 'monthly', 119_00]]);
    expect(found[0].active).toBe(true);
  });

  it('uses the newest price after a price increase', () => {
    const d = data([...monthly('s', 'Netflix', -119_00, 6, 4), ...monthly('t', 'Netflix', -129_00, 6, 2, '2026-05')]);
    expect(detectSubscriptions(d, resolveAll(d))[0].amount).toBe(129_00);
  });

  it('allows a varying amount for bills (betalingsservice) and marks it variable', () => {
    const amounts = [450_00, 780_00, 520_00, 610_00, 700_00, 480_00];
    const d = data(amounts.map((a, i) => tx(`e${i}`, `2026-0${i + 1}-04`, 'Betalingsservice Lysværket', -a)));
    const [f] = detectSubscriptions(d, resolveAll(d));
    expect([f.name, f.variable]).toEqual(['Lysværket', true]);
    // Men en varierende kortbetaling (fx benzin) er ikke et abonnement.
    const d2 = data(amounts.map((a, i) => tx(`b${i}`, `2026-0${i + 1}-12`, 'Kortkøb Tankstation Vest', -a)));
    expect(detectSubscriptions(d2, resolveAll(d2))).toEqual([]);
  });

  it('finds quarterly and yearly bills', () => {
    const d = data([
      tx('q1', '2025-01-10', 'Forsikring Tryghed', -1_840_00), tx('q2', '2025-04-10', 'Forsikring Tryghed', -1_840_00),
      tx('q3', '2025-07-10', 'Forsikring Tryghed', -1_840_00), tx('q4', '2025-10-10', 'Forsikring Tryghed', -1_840_00),
      tx('y1', '2024-11-02', 'Licens Medie', -2_400_00), tx('y2', '2025-11-03', 'Licens Medie', -2_400_00),
      tx('z', '2025-12-01', 'Andet', -1_00),
    ]);
    const found = detectSubscriptions(d, resolveAll(d));
    expect(found.map((f) => [f.name, f.cadence]).sort()).toEqual([['Forsikring Tryghed', 'quarterly'], ['Licens Medie', 'yearly']]);
  });

  it('marks a subscription that has stopped as inactive', () => {
    const d = data([...monthly('s', 'Fitness Puls', -279_00, 9, 4), tx('later', '2026-12-01', 'Andet', -10_00)]);
    expect(detectSubscriptions(d, resolveAll(d))[0].active).toBe(false);
  });

  it('ignores transfers between own accounts', () => {
    const d = demoData();
    const names = detectSubscriptions(d, resolveAll(d)).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Husleje Boligforeningen Kastanjen', 'Lysværket', 'Fiberby', 'Streamio', 'Mobilselskabet Prik', 'Fitness Puls']));
    expect(names.some((n) => /overførsel|opsparing|billån/i.test(n))).toBe(false);
  });

  it('finds subscriptions whose text changes from charge to charge', () => {
    const refs = ['P3A1B2C9', 'P7Q2Z4K1', 'P1X8M3V5', 'P9D6F2H4', 'P2L5N7R8'];
    const d = data([
      ...refs.map((r, i) => tx(`p${i}`, addMonthsKeepDay('2026-01-14', i), `PAYPAL *SPOTIFY ${r} STOCKHOLM`, -109_00)),
      ...[...Array(5)].map((_, i) => tx(`n${i}`, addMonthsKeepDay('2026-01-03', i), i % 2 ? `NETFLIX.COM 866-579-${7170 + i}` : `Visa/Dankort Netflix.com ${i + 10}.0${i + 1}`, -129_00)),
    ]);
    const found = detectSubscriptions(d, resolveAll(d));
    expect(found.map((f) => [f.cadence, f.amount, f.txIds.length]).sort()).toEqual([['monthly', 109_00, 5], ['monthly', 129_00, 5]]);
  });

  it('tolerates a missing month and a big price increase', () => {
    const dates = ['2026-01-05', '2026-02-05', '2026-04-06', '2026-05-05', '2026-06-05', '2026-07-06'];
    const d = data(dates.map((dt, i) => tx(`m${i}`, dt, 'Musikkassen', -(i < 3 ? 99_00 : 129_00))));
    const [f] = detectSubscriptions(d, resolveAll(d));
    expect([f.cadence, f.amount, f.txIds.length]).toEqual(['monthly', 129_00, 6]);
  });

  it('splits two subscriptions with the same merchant by amount', () => {
    const d = data([...monthly('a', 'Apple.com/bill', -12_00, 2), ...monthly('b', 'APPLE.COM/BILL', -109_00, 18)]);
    const found = detectSubscriptions(d, resolveAll(d));
    expect(found.map((f) => f.amount).sort((a, b) => a - b)).toEqual([12_00, 109_00]);
  });

  it('cleans up names', () => {
    expect(subName('Betalingsservice Fiberby')).toBe('Fiberby');
    expect(subName('Fitness Puls medlemskab 0423')).toBe('Fitness Puls');
  });
});

describe('brugerens rettelser', () => {
  const base = data(monthly('s', 'Streamio abonnement', -119_00, 6));
  const items = (d: AppData) => budgetItems(d, resolveAll(d));

  it('lets the user correct a detected subscription, and undo it', () => {
    const [found] = items(base);
    expect(found.source).toBe('detected');
    const d = saveSubscription(base, { id: 'sub-1', key: found.key, name: 'Streamio Premium', amount: 149_00, cadence: 'monthly', anchor: '2026-07-08' });
    const [edited] = items(d);
    expect([edited.name, edited.amount, edited.anchor, edited.source]).toEqual(['Streamio Premium', 149_00, '2026-07-08', 'edited']);
    // Trækkene følger stadig med, så betalte måneder kan markeres.
    expect(paidTx(edited, '2026-03-06', new Map(d.txs.map((t) => [t.id, t])))?.id).toBe('s2');
    expect(items(resetSubscription(d, found.key!))[0].source).toBe('detected');
  });

  it('hides a wrong guess and can show it again', () => {
    const [found] = items(base);
    const hidden = removeSubscription(base, found);
    expect(items(hidden)).toEqual([]);
    expect(items(restoreSubscription(hidden, found.key!))).toHaveLength(1);
  });

  it('adds a missing subscription and recognises its payments', () => {
    const d0 = data([tx('h1', '2026-02-15', 'MobilePay HBO Max', -79_00)]);
    const d = saveSubscription(d0, { id: 'sub-m', name: 'HBO Max', match: 'HBO Max', amount: 79_00, cadence: 'monthly', anchor: '2026-03-15' });
    const [m] = items(d);
    expect([m.source, m.txIds]).toEqual(['manual', ['h1']]);
    expect(items(removeSubscription(d, m))).toEqual([]);
  });

  it('survives a backup round trip and merges', () => {
    const d = saveSubscription(base, { id: 'sub-m', name: 'Avis', amount: 99_00, cadence: 'monthly', anchor: '2026-03-01' });
    const b = makeBackup(d, 'full');
    expect(applyBackup(emptyData(), b, 'replace').budget?.subscriptions.map((s) => s.name)).toEqual(['Avis']);
    const other = saveSubscription(emptyData(), { id: 'sub-x', name: 'Musik', amount: 59_00, cadence: 'monthly', anchor: '2026-03-01' });
    expect(applyBackup(other, b, 'merge').budget?.subscriptions.map((s) => s.name).sort()).toEqual(['Avis', 'Musik']);
  });
});
