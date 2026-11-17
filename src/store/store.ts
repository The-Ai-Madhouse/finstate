import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { emptyData } from '../domain/defaults';
import { withAutoBookStart } from '../domain/engine';
import type { TxFilter } from '../domain/txfilter';
import type { AppData } from '../domain/types';

export type View = 'overview' | 'import' | 'ledger' | 'transfers' | 'balance' | 'statement' | 'slides' | 'settings' | 'versions';

interface State {
  data: AppData;
  view: View;
  periodId?: string;
  /** Fane i Indstillinger, når man linkes direkte derhen. */
  settingsTab?: string;
  /** Transaktion der skal vises/fremhæves i Kategorisér (fx fra Overførsler). */
  focusTxId?: string;
  storageError?: string;
  saveStatus: SaveStatus;
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
  /** settle: rul til Afstemning (postId: med posten foldet ud). Ellers: interne overførsler for en konto/én overførsel. */
  transferFocus?: { accountId?: string; txId?: string; postId?: string; settle?: boolean };
  showTransfers: (focus: { accountId?: string; txId?: string; postId?: string; settle?: boolean }) => void;
  clearTransferFocus: () => void;
  /** "Hører sammen med": transaktionen, man er ved at knytte til en anden (klik på den anden i listen). */
  linkPick?: LinkPick;
  setLinkPick: (pick?: LinkPick) => void;
  /** Valgt par, der venter på at blive bekræftet (og evt. hvor resten skal hen). */
  pairDraft?: { pick: LinkPick; otherId: string };
  setPairDraft: (draft?: { pick: LinkPick; otherId: string }) => void;
  /** Gå til Aktiver & passiver med en post foldet ud. */
  balanceFocus?: string;
  showPost: (accountId: string) => void;
  clearBalanceFocus: () => void;
  setPeriod: (id?: string) => void;
}

/**
 * Vælg en anden transaktion (søg eller klik i listen):
 *  plain = almindelige transaktioner (fx udlæg og indbetaling) · post = par på en afstemt post (fx udlæg ↔ tilbagebetaling) · bank = find modposten til en overførsel mellem dine konti
 */
export type LinkPick = { txId: string; mode: 'plain' | 'post' | 'bank'; postId?: string; periodId?: string };

export type LedgerFilter = TxFilter;
export const DEFAULT_LEDGER_FILTER: LedgerFilter = { q: '', type: 'all', status: 'all', withNote: false, sort: 'date-asc' };

const KEY = 'finstate:v1';

/** Hvor gemmes der lige nu? file = i datafilen på computeren (via npm start), browser = kun i browseren (serveren svarer ikke). */
export interface SaveStatus { mode: 'loading' | 'file' | 'browser'; dir?: string; savedAt?: string; error?: string }

let hydrated = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: string | undefined;
let serverOk = false;

const setStatus = (patch: Partial<SaveStatus>) => {
  // useStore er defineret længere nede – kaldes først, når appen kører.
  const cur = useStore.getState().saveStatus;
  useStore.setState({ saveStatus: { ...cur, ...patch } });
};

async function putFile(text: string) {
  try {
    const r = await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    serverOk = true;
    setStatus({ mode: 'file', savedAt: new Date().toISOString(), error: undefined });
  } catch (e) {
    serverOk = false;
    setStatus({ mode: 'browser', error: `Kunne ikke gemme i datafilen (${(e as Error).message}). Data er kun gemt i browseren – kører "npm start"?` });
  }
}

function flush() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (pending !== undefined) { const t = pending; pending = undefined; void putFile(t); }
}

// Gem det sidste, når fanen lukkes (sendBeacon overlever, at siden forsvinder).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (pending !== undefined && serverOk) navigator.sendBeacon('/api/data', new Blob([pending], { type: 'application/json' }));
    pending = undefined;
  });
}

/**
 * Lagring: datafilen på computeren er det rigtige sted; browserens localStorage er en kopi/nødløsning.
 * Første gang (ingen datafil endnu) flyttes browserens data over i filen.
 */
const fileStorage: StateStorage = {
  getItem: async (k) => {
    let local: string | null = null;
    try { local = localStorage.getItem(k); } catch { /* ingen adgang */ }
    try {
      const info = await fetch('/api/storage', { cache: 'no-store' });
      if (!info.ok) throw new Error((await info.json().catch(() => ({}))).error ?? `HTTP ${info.status}`);
      const meta = (await info.json()) as { dir: string; exists: boolean; savedAt?: string };
      serverOk = true;
      setStatus({ mode: 'file', dir: meta.dir, savedAt: meta.savedAt, error: undefined });
      if (meta.exists) {
        const r = await fetch('/api/data', { cache: 'no-store' });
        if (r.ok) return await r.text();
      }
      // Ingen datafil endnu: flyt browserens data over.
      if (local) await putFile(local);
      return local;
    } catch (e) {
      serverOk = false;
      setStatus({ mode: 'browser', error: `Datafilen kunne ikke læses (${(e as Error).message}). Viser browserens kopi – kører "npm start"?` });
      return local;
    }
  },
  setItem: (k, v) => {
    // Gem aldrig noget, før data er indlæst – ellers kunne en tom start overskrive filen.
    if (!hydrated) return;
    try {
      localStorage.setItem(k, v);
      if (useStore.getState().storageError) useStore.setState({ storageError: undefined });
    } catch (e) {
      // Fyldt browser er kun et problem, hvis datafilen heller ikke virker.
      if (!serverOk) useStore.setState({ storageError: `Kunne ikke gemme i browseren (${(e as Error).name}), og datafilen svarer ikke. Eksportér en backup nu!` });
    }
    pending = v;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 400);
  },
  removeItem: (k) => localStorage.removeItem(k),
};

export const useStore = create<State>()(
  persist(
    (set) => ({
      data: emptyData(),
      view: 'overview',
      saveStatus: { mode: 'loading' },
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
      setPairDraft: (pairDraft) => set({ pairDraft }),
      showPost: (balanceFocus) => set({ view: 'balance', balanceFocus }),
      clearBalanceFocus: () => set({ balanceFocus: undefined }),
      setPeriod: (periodId) => set({ periodId }),
    }),
    {
      name: KEY,
      version: 1,
      storage: createJSONStorage(() => fileStorage),
      onRehydrateStorage: () => () => { hydrated = true; },
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
