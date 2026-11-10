import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { emptyData } from '../domain/defaults';
import { withAutoBookStart } from '../domain/engine';
import type { TxFilter } from '../domain/txfilter';
import type { AppData } from '../domain/types';

export type View = 'overview' | 'import' | 'ledger' | 'transfers' | 'balance' | 'statement' | 'slides' | 'settings';

interface State {
  data: AppData;
  view: View;
  periodId?: string;
  /** Fane i Indstillinger, når man linkes direkte derhen. */
  settingsTab?: string;
  /** Transaktion der skal vises/fremhæves i Kategorisér (fx fra Overførsler). */
  focusTxId?: string;
  storageError?: string;
  /** Kategorisér: søgning og filtre huskes, når man går væk og kommer tilbage. */
  ledgerFilter: LedgerFilter;
  setLedgerFilter: (patch: Partial<LedgerFilter>) => void;
  /** Nulstil alle filtre (konto, kategori, datoer, beløb …) – sorteringen bevares. */
  resetLedgerFilter: () => void;
  update: (recipe: (d: AppData) => AppData) => void;
  replaceAll: (d: AppData) => void;
  markExported: () => void;
  setView: (v: View, settingsTab?: string) => void;
  showTx: (id: string) => void;
  clearFocusTx: () => void;
  /** Gå til Overførsler med fokus på en post (konto) eller én bestemt overførsel. */
  transferFocus?: { accountId?: string; txId?: string };
  showTransfers: (focus: { accountId?: string; txId?: string }) => void;
  clearTransferFocus: () => void;
  /** "Hører sammen med": transaktionen, man er ved at knytte til en anden (klik på den anden i listen). */
  linkPick?: string;
  setLinkPick: (txId?: string) => void;
  setPeriod: (id?: string) => void;
}

export type LedgerFilter = TxFilter;
export const DEFAULT_LEDGER_FILTER: LedgerFilter = { q: '', type: 'all', status: 'all', withNote: false, sort: 'date-asc' };

const KEY = 'finstate:v1';

// localStorage med tydelig fejl, hvis pladsen (≈5 MB) slipper op – så intet tabes i stilhed.
const safeStorage: StateStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
      if (useStore.getState().storageError) useStore.setState({ storageError: undefined });
    } catch (e) {
      useStore.setState({ storageError: `Kunne ikke gemme i browseren (${(e as Error).name}). Eksportér en backup nu!` });
    }
  },
  removeItem: (k) => localStorage.removeItem(k),
};

export const useStore = create<State>()(
  persist(
    (set) => ({
      data: emptyData(),
      view: 'overview',
      ledgerFilter: DEFAULT_LEDGER_FILTER,
      setLedgerFilter: (patch) => set((s) => ({ ledgerFilter: { ...s.ledgerFilter, ...patch } })),
      resetLedgerFilter: () => set((s) => ({ ledgerFilter: { ...DEFAULT_LEDGER_FILTER, sort: s.ledgerFilter.sort } })),
      update: (recipe) =>
        set((s) => {
          const d = withAutoBookStart(recipe(s.data));
          return { data: { ...d, settings: { ...d.settings, lastChangeAt: new Date().toISOString() } } };
        }),
      replaceAll: (raw) => {
        const d = withAutoBookStart(raw);
        set({ data: { ...d, settings: { ...d.settings, lastChangeAt: new Date().toISOString() } } });
      },
      markExported: () => set((s) => ({ data: { ...s.data, settings: { ...s.data.settings, lastExportAt: new Date().toISOString() } } })),
      setView: (view, settingsTab) => set({ view, settingsTab }),
      showTx: (focusTxId) => set({ view: 'ledger', focusTxId }),
      clearFocusTx: () => set({ focusTxId: undefined }),
      showTransfers: (transferFocus) => set({ view: 'transfers', transferFocus }),
      clearTransferFocus: () => set({ transferFocus: undefined }),
      setLinkPick: (linkPick) => set({ linkPick }),
      setPeriod: (periodId) => set({ periodId }),
    }),
    {
      name: KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ data: s.data, view: s.view, periodId: s.periodId }),
      // Nye felter i fremtidige versioner får standardværdier.
      merge: (persisted, current) => {
        const p = persisted as Partial<State> | undefined;
        if (!p?.data) return current;
        return { ...current, ...p, data: withAutoBookStart({ ...emptyData(), ...p.data, settings: { ...emptyData().settings, ...p.data.settings } }) };
      },
    },
  ),
);

// Bed browseren om ikke at rydde data ved pladsmangel.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persisted().then((p) => (p ? undefined : navigator.storage.persist())).catch(() => {});
}

export const useData = () => useStore((s) => s.data);
export const update = (recipe: (d: AppData) => AppData) => useStore.getState().update(recipe);

export function storageUsage(): number {
  try {
    return (localStorage.getItem(KEY)?.length ?? 0) * 2;
  } catch {
    return 0;
  }
}
