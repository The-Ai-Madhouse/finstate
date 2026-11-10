/** Status for en intern overførsel – samme vurdering på Overførsler-siden og i Aktiver & passiver. */
import type { Resolved } from './classify';
import { balancesAt, isTransitRef, transitAccountId, type Ledger } from './ledger';
import type { Account, AppData, Period, Tx } from './types';
import { addDays } from './util';

export type TransferKind = 'pair' | 'transit' | 'direct' | 'missing';

export interface TransferInfo {
  kind: TransferKind;
  /** Den anden side (parret, eller undervejs i en anden periode). */
  partner?: Tx;
  /** Den post, pengene flytter til/fra. */
  target?: Account;
  /** Bogført mod penge undervejs fra en tidligere periode. */
  transitRef?: string;
}

export const TRANSFER_LABEL: Record<TransferKind, string> = {
  pair: 'Parret',
  transit: 'Undervejs',
  direct: 'Direkte',
  missing: 'Mangler modpost',
};

export function transferInfo(data: AppData, resolved: Map<string, Resolved>, txById: Map<string, Tx>, tx: Tx, period: Pick<Period, 'start' | 'end'>): TransferInfo | undefined {
  const r = resolved.get(tx.id);
  const line = r?.lines.find((l) => l.type === 'internal');
  if (!r || !line) return undefined;
  if (line.transitRef) return { kind: 'direct', transitRef: line.transitRef };
  const target = data.accounts.find((a) => a.id === line.targetAccountId);
  const partner = r.pairId ? txById.get(r.pairId) : undefined;
  if (partner) return { kind: partner.date >= period.start && partner.date <= period.end ? 'pair' : 'transit', partner, target };
  if (target && (target.kind !== 'bank' || !data.txs.some((x) => x.accountId === target.id))) return { kind: 'direct', target };
  return { kind: 'missing', target };
}

/** Penge, der var undervejs ved periodens start: hvad er landet i perioden, og hvad mangler. */
export interface CarriedTransit {
  ref: string;
  /** Undervejs ved periodens start (+ = penge på vej til dig). */
  primo: number;
  /** Transaktioner i perioden, der har hentet beløbet – automatisk (modtagerkontoen) eller valgt af dig. */
  landed: { tx: Tx; amount: number; chosen: boolean }[];
  /** Mangler endnu at lande (0 = alt er landet). */
  remaining: number;
}

export function carriedTransit(data: AppData, ledger: Ledger, resolved: Map<string, Resolved>, period: Pick<Period, 'start' | 'end'>): CarriedTransit[] {
  const txById = new Map(data.txs.map((t) => [t.id, t]));
  const primo = balancesAt(ledger, addDays(period.start, -1));
  const out: CarriedTransit[] = [];
  for (const [ref, v] of primo) {
    if (!isTransitRef(ref) || !v) continue;
    // Kun det, der henter det medbragte beløb: modsat fortegn, og ikke parret med noget inden for perioden
    // (overførsler, hvor begge sider ligger i perioden, går op i sig selv og har intet med primo at gøre).
    const inP = (t?: Tx) => !!t && t.date >= period.start && t.date <= period.end;
    const byTx = new Map<string, number>();
    for (const p of ledger.postings) {
      if (p.ref !== ref || !p.txId || p.date < period.start || p.date > period.end) continue;
      const pair = resolved.get(p.txId)?.pairId;
      if (pair && inP(txById.get(pair))) continue;
      byTx.set(p.txId, (byTx.get(p.txId) ?? 0) + p.amount);
    }
    for (const [id, a] of byTx) if (Math.sign(a) !== -Math.sign(v)) byTx.delete(id);
    const landed = [...byTx].map(([id, amount]) => ({
      tx: txById.get(id)!,
      amount,
      chosen: !!resolved.get(id)?.lines.some((l) => l.transitRef === ref),
    })).filter((x) => x.tx).sort((a, b) => (a.tx.date < b.tx.date ? -1 : 1));
    out.push({ ref, primo: v, landed, remaining: v + landed.reduce((s, x) => s + x.amount, 0) });
  }
  return out;
}

/** Mulige transaktioner for det, der mangler at lande: samme retning, i perioden, helst på modtagerkontoen og med samme beløb. */
export function transitCandidates(data: AppData, resolved: Map<string, Resolved>, period: Pick<Period, 'start' | 'end'>, c: CarriedTransit): Tx[] {
  if (!c.remaining) return [];
  const receiver = transitAccountId(c.ref);
  return data.txs
    .filter((t) => t.date >= period.start && t.date <= period.end && Math.sign(t.amount) === Math.sign(c.remaining))
    .filter((t) => { const r = resolved.get(t.id); return !r?.pairId && !r?.lines.some((l) => l.transitRef); })
    .sort((a, b) =>
      Number(b.accountId === receiver) - Number(a.accountId === receiver) ||
      Number(b.amount === c.remaining) - Number(a.amount === c.remaining) ||
      (a.date < b.date ? -1 : 1));
}

/**
 * Transaktionerne i perioden, der flytter penge direkte til/fra en post (fx "Jonas skylder mig" eller et billån) –
 * de hører sammen via posten.
 */
export function postMovements(data: AppData, resolved: Map<string, Resolved>, accountId: string, period: Pick<Period, 'start' | 'end'>): Tx[] {
  return data.txs
    .filter((t) => t.date >= period.start && t.date <= period.end && t.accountId !== accountId)
    .filter((t) => resolved.get(t.id)?.lines.some((l) => l.type === 'internal' && l.targetAccountId === accountId))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
