import type { AppData } from './types';
import { emptyData } from './defaults';

export const APP_ID = 'finstate';

export interface BackupFile {
  app: typeof APP_ID;
  kind: 'full' | 'rules';
  version: 1;
  exportedAt: string;
  /** Hvilken app-version der lavede filen, fx "v0.1.0 · build 41 · 98f2986". */
  appVersion?: string;
  data: Partial<AppData>;
}

export function makeBackup(data: AppData, kind: 'full' | 'rules', appVersion?: string): BackupFile {
  const payload: Partial<AppData> =
    kind === 'full'
      ? data
      : { categories: data.categories, rules: data.rules, bankMap: data.bankMap, accounts: data.accounts, importProfiles: data.importProfiles };
  return { app: APP_ID, kind, version: 1, exportedAt: new Date().toISOString(), appVersion, data: payload };
}

export function parseBackup(text: string): BackupFile {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('Filen er ikke gyldig JSON.');
  }
  const b = obj as BackupFile;
  if (!b || b.app !== APP_ID || !b.data) throw new Error('Filen er ikke en Finstate-backup.');
  if (b.version !== 1) throw new Error(`Ukendt backup-version: ${String(b.version)}`);
  for (const k of ['txs', 'rules', 'categories', 'accounts', 'valuations', 'openItems', 'matches', 'imports', 'periods'] as const) {
    if (b.data[k] !== undefined && !Array.isArray(b.data[k])) throw new Error(`Feltet "${k}" har forkert format.`);
  }
  return b;
}

function mergeById<T extends { id: string }>(cur: T[], inc: T[] | undefined): T[] {
  if (!inc) return cur;
  const m = new Map(cur.map((x) => [x.id, x]));
  for (const x of inc) m.set(x.id, x); // indkommende vinder
  return [...m.values()];
}

/**
 * replace: erstat alt med backuppen (felter der mangler i filen bevares).
 * merge: flet på id – backuppens version vinder ved konflikt. Godt til at hente
 * regler fra en anden browser uden at miste lokale transaktioner.
 */
export function applyBackup(cur: AppData, b: BackupFile, mode: 'replace' | 'merge'): AppData {
  const d = b.data;
  if (mode === 'replace') {
    const base = b.kind === 'full' ? emptyData() : cur;
    return { ...base, ...d, version: 1, settings: { ...base.settings, ...d.settings } } as AppData;
  }
  return {
    ...cur,
    settings: { ...cur.settings, ...(d.settings ?? {}) },
    accounts: mergeById(cur.accounts, d.accounts),
    categories: mergeById(cur.categories, d.categories),
    rules: mergeById(cur.rules, d.rules),
    bankMap: { ...cur.bankMap, ...(d.bankMap ?? {}) },
    txs: mergeById(cur.txs, d.txs),
    valuations: mergeById(cur.valuations, d.valuations),
    openItems: mergeById(cur.openItems, d.openItems),
    matches: mergeById(cur.matches ?? [], d.matches),
    imports: mergeById(cur.imports ?? [], d.imports),
    periods: mergeById(cur.periods, d.periods),
    slideNotes: { ...cur.slideNotes, ...(d.slideNotes ?? {}) },
    importProfiles: { ...cur.importProfiles, ...(d.importProfiles ?? {}) },
  };
}
