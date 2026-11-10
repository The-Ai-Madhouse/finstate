/**
 * "Hører sammen": en note til dig selv om, at nogle transaktioner hører sammen
 * (fx et køb og en refusion, eller en regning og den, der lagde ud). Ændrer intet i regnskabet.
 */
import type { AppData, Tx } from './types';
import { uid } from './util';

/** De andre transaktioner i samme gruppe. */
export function linkedWith(txs: Tx[], tx: Tx): Tx[] {
  return tx.link ? txs.filter((t) => t.link === tx.link && t.id !== tx.id) : [];
}

/** Knyt b til a's gruppe (to eksisterende grupper lægges sammen). */
export function linkTxs(d: AppData, aId: string, bId: string): AppData {
  const a = d.txs.find((t) => t.id === aId), b = d.txs.find((t) => t.id === bId);
  if (!a || !b || a.id === b.id) return d;
  const id = a.link ?? b.link ?? uid('link');
  const merge = new Set([a.link, b.link].filter(Boolean));
  return { ...d, txs: d.txs.map((t) => (t.id === aId || t.id === bId || (t.link && merge.has(t.link)) ? { ...t, link: id } : t)) };
}

/** Tag en transaktion ud af sin gruppe. Står der kun én tilbage, opløses gruppen. */
export function unlinkTx(d: AppData, id: string): AppData {
  const tx = d.txs.find((t) => t.id === id);
  if (!tx?.link) return d;
  const rest = d.txs.filter((t) => t.link === tx.link && t.id !== id);
  const drop = new Set([id, ...(rest.length === 1 ? [rest[0].id] : [])]);
  return { ...d, txs: d.txs.map((t) => { if (!drop.has(t.id)) return t; const n = { ...t }; delete n.link; return n; }) };
}

export interface LinkGroup {
  id: string;
  txs: Tx[];
  /** Summen af transaktionerne (0 = går op). */
  sum: number;
  /** Differencen er afskrevet (godkendt) – og summen er stadig den samme som da. */
  accepted: boolean;
  note?: string;
}

/** Grupper med mindst én transaktion i perioden – til afstemningsoversigten. */
export function linkGroups(d: Pick<AppData, 'txs' | 'linkGroups'>, period?: { start: string; end: string }): LinkGroup[] {
  const by = new Map<string, Tx[]>();
  for (const t of d.txs) if (t.link) by.set(t.link, [...(by.get(t.link) ?? []), t]);
  const out: LinkGroup[] = [];
  for (const [id, txs] of by) {
    if (txs.length < 2) continue;
    if (period && !txs.some((t) => t.date >= period.start && t.date <= period.end)) continue;
    txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const sum = txs.reduce((s, t) => s + t.amount, 0);
    const meta = d.linkGroups?.[id];
    out.push({ id, txs, sum, accepted: sum !== 0 && meta?.accepted === sum, note: meta?.note });
  }
  return out.sort((a, b) => (a.txs[0].date < b.txs[0].date ? -1 : 1));
}

/**
 * Afskriv (godkend) differencen i en gruppe. Beløbene står allerede i regnskabet under transaktionernes kategorier,
 * så intet bogføres – gruppen markeres blot som afstemt. Ændres gruppen bagefter, skal differencen godkendes igen.
 */
export function acceptLinkDifference(d: AppData, id: string, accept: boolean, note?: string): AppData {
  const sum = d.txs.filter((t) => t.link === id).reduce((s, t) => s + t.amount, 0);
  const groups = { ...(d.linkGroups ?? {}) };
  if (accept) groups[id] = { ...groups[id], accepted: sum, ...(note !== undefined ? { note } : {}) };
  else { const g = { ...groups[id] }; delete g.accepted; groups[id] = g; }
  return { ...d, linkGroups: groups };
}
