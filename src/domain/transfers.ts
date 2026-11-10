/** Status for en intern overførsel – samme vurdering på Overførsler-siden og i Aktiver & passiver. */
import type { Resolved } from './classify';
import type { Account, AppData, Period, Tx } from './types';

export type TransferKind = 'pair' | 'transit' | 'direct' | 'missing';

export interface TransferInfo {
  kind: TransferKind;
  /** Den anden side (parret, eller undervejs i en anden periode). */
  partner?: Tx;
  /** Den post, pengene flytter til/fra. */
  target?: Account;
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
  const target = data.accounts.find((a) => a.id === line.targetAccountId);
  const partner = r.pairId ? txById.get(r.pairId) : undefined;
  if (partner) return { kind: partner.date >= period.start && partner.date <= period.end ? 'pair' : 'transit', partner, target };
  if (target && (target.kind !== 'bank' || !data.txs.some((x) => x.accountId === target.id))) return { kind: 'direct', target };
  return { kind: 'missing', target };
}
