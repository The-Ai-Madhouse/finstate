import { describe, expect, it } from 'vitest';
import { buildTxs, guessMapping, isCompleteMapping, parseCsv, tradeInfo } from './csv';

const build = (csv: string) => {
  const sheet = parseCsv(csv);
  const m = guessMapping(sheet);
  expect(isCompleteMapping(m)).toBe(true);
  return { m, txs: buildTxs(sheet, m as never, 'acc-d').txs };
};

describe('kurtage ved import', () => {
  it('reads a fee column (Nordnet-style)', () => {
    const { m, txs } = build([
      'Id;Bogføringsdag;Handelsdag;Depot;Transaktionstype;Værdipapirer;ISIN;Antal;Kurs;Samlede afgifter;Valuta;Beløb;Saldo',
      '1;2026-03-02;2026-02-27;123;KØBT;Novo Nordisk B;DK0062498333;10;700,00;29,00;DKK;-7.029,00;2.971,00',
      '2;2026-03-10;2026-03-06;123;SOLGT;Novo Nordisk B;DK0062498333;5;720,00;29,00;DKK;3.571,00;6.542,00',
      '3;2026-03-15;2026-03-15;123;INDBETALING;;;;;;DKK;1.000,00;7.542,00',
    ].join('\n'));
    expect(m.fee).toBeDefined();
    // Antal og kurs bruges ikke (de kan være i en anden valuta).
    expect(Object.keys(m)).not.toContain('quantity');
    const [buy, sell, dep] = txs;
    expect(buy.trade).toEqual({ fee: 2900, gross: 700000, side: 'buy' });
    expect(sell.trade).toEqual({ fee: 2900, gross: 360000, side: 'sell' });
    expect(dep.trade).toBeUndefined();
  });

  it('reads an English fee column (Saxo-style)', () => {
    const { txs } = build([
      'Trade Date,Instrument,Buy/Sell,Commission,Booked Amount',
      '2026-04-01,Apple Inc,Buy,14.00,-5014.00',
      '2026-04-02,Dividend Apple,,,120.00',
    ].join('\n'));
    expect(txs[0].trade).toEqual({ fee: 1400, gross: 500000, side: 'buy' });
    expect(txs[1].trade).toBeUndefined();
  });

  it('finds the fee in the text (bank accounts like Jyske, Danske, Lunar)', () => {
    expect(tradeInfo(-702900, 'Køb 10 stk Novo Nordisk B kurs 700,00 kurtage 29,00')).toEqual({ fee: 2900, gross: 700000, side: 'buy' });
    expect(tradeInfo(-502000, 'Fondshandel · Vestas · Kurt. 20')).toMatchObject({ fee: 2000, gross: 500000 });
    expect(tradeInfo(357100, 'Salg Novo Nordisk B, kurtage 29,00')).toEqual({ fee: 2900, gross: 360000, side: 'sell' });
    // Ingen kurtage – heller ikke ud fra antal × kurs.
    expect(tradeInfo(-702900, 'Køb 10 stk Novo Nordisk B kurs 700,00')).toBeUndefined();
    expect(tradeInfo(-45000, 'Netto 1234')).toBeUndefined();
    // Et almindeligt gebyr, der er hele beløbet, er ikke kurtage.
    expect(tradeInfo(-1500, 'Gebyr 15,00')).toBeUndefined();
  });
});
