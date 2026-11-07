import type { Tx } from './types';
import { groupBy } from './util';

export interface ChainBreak {
  /** Transaktionen hvor kæden brød. */
  txId: string;
  date: string;
  expectedBefore: number;
  actualBefore: number;
  /** Difference = beløb der mangler (eller er for meget) mellem de to poster. */
  diff: number;
}

/**
 * Ordner en kontos transaktioner kronologisk og – inden for samme dag – i den
 * rækkefølge, saldokæden dikterer (forrige saldo + beløb = saldo). Rapporterer brud.
 */
export function orderChain(txs: Tx[]): { ordered: Tx[]; breaks: ChainBreak[] } {
  const byDate = [...groupBy(txs, (t) => t.date).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const ordered: Tx[] = [];
  const breaks: ChainBreak[] = [];
  let prev: number | undefined;
  for (const [, dayTxs] of byDate) {
    const pool = [...dayTxs].sort((a, b) => a.seq - b.seq);
    while (pool.length) {
      let i = prev === undefined ? -1 : pool.findIndex((t) => t.balance !== undefined && t.balance - t.amount === prev);
      if (i < 0 && prev === undefined) {
        // Første dag: vælg den post, ingen anden post i puljen "peger på".
        i = pool.findIndex((t) => t.balance === undefined || !pool.some((o) => o !== t && o.balance !== undefined && o.balance === t.balance! - t.amount));
      }
      if (i < 0) i = 0;
      const t = pool.splice(i, 1)[0];
      if (t.balance !== undefined) {
        const before = t.balance - t.amount;
        if (prev !== undefined && before !== prev) {
          breaks.push({ txId: t.id, date: t.date, expectedBefore: prev, actualBefore: before, diff: before - prev });
        }
        prev = t.balance;
      } else if (prev !== undefined) prev += t.amount;
      ordered.push(t);
    }
  }
  return { ordered, breaks };
}

/** Saldo efter sidste transaktion på eller før datoen (ud fra bankens saldo-kolonne). */
export function bankBalanceAt(ordered: Tx[], date: string): number | undefined {
  let last: Tx | undefined;
  for (const t of ordered) {
    if (t.date > date) break;
    last = t;
  }
  return last?.balance;
}
