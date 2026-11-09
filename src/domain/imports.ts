/** Importerede filer: oversigt og fjernelse. */
import type { AppData, Tx } from './types';

export interface ImportFile {
  id: string;
  fileName: string;
  accountId: string;
  importedAt: string;
  /** Alle transaktioner i filen, der stadig findes. */
  txs: Tx[];
  /** Transaktioner, der kun kommer fra denne fil (fjernes, hvis filen fjernes). */
  onlyHere: number;
  first?: string;
  last?: string;
  /** Importeret før Finstate huskede filerne – grupperet efter importtidspunkt. */
  legacy?: boolean;
}

export function importFiles(d: AppData): ImportFile[] {
  const byId = new Map(d.txs.map((t) => [t.id, t]));
  const records = d.imports ?? [];
  const count = new Map<string, number>();
  for (const r of records) for (const id of new Set(r.txIds)) count.set(id, (count.get(id) ?? 0) + 1);
  const files: ImportFile[] = records.map((r) => {
    const txs = r.txIds.map((id) => byId.get(id)).filter((t): t is Tx => !!t);
    return { id: r.id, fileName: r.fileName, accountId: r.accountId, importedAt: r.importedAt, txs, onlyHere: txs.filter((t) => count.get(t.id) === 1).length };
  });
  // Ældre imports uden filregistrering: én "fil" pr. konto og importtidspunkt.
  const legacy = new Map<string, Tx[]>();
  for (const t of d.txs) {
    if (count.has(t.id)) continue;
    const k = `legacy:${t.accountId}|${t.importedAt}`;
    (legacy.get(k) ?? legacy.set(k, []).get(k)!).push(t);
  }
  for (const [id, txs] of legacy) {
    files.push({ id, fileName: 'Tidligere import', accountId: txs[0].accountId, importedAt: txs[0].importedAt, txs, onlyHere: txs.length, legacy: true });
  }
  for (const f of files) {
    const dates = f.txs.map((t) => t.date).sort();
    f.first = dates[0];
    f.last = dates[dates.length - 1];
    f.txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  }
  return files.sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

/** Fjern en fil: dens transaktioner slettes – undtagen dem, som en anden importeret fil også indeholder. */
export function removeImport(d: AppData, id: string): AppData {
  const file = importFiles(d).find((f) => f.id === id);
  if (!file) return d;
  const others = new Set((d.imports ?? []).filter((r) => r.id !== id).flatMap((r) => r.txIds));
  const drop = new Set(file.txs.map((t) => t.id).filter((tid) => !others.has(tid)));
  return { ...d, txs: d.txs.filter((t) => !drop.has(t.id)), imports: (d.imports ?? []).filter((r) => r.id !== id) };
}
