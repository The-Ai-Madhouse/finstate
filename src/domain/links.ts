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
