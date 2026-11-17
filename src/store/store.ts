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
  /** Login udløbet/logget ud – vis login igen. */
  authLost?: boolean;
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

/** Hvor gemmes der lige nu? file = krypteret i datafilen (via serveren); error = serveren kunne ikke gemme. */
export interface SaveStatus { mode: 'loading' | 'file' | 'error'; dir?: string; savedAt?: string; error?: string }

let hydrated = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: string | undefined;

const setStatus = (patch: Partial<SaveStatus>) => {
  // useStore er defineret længere nede – kaldes først, når appen kører.
  const cur = useStore.getState().saveStatus;
  useStore.setState({ saveStatus: { ...cur, ...patch } });
};

/** Login er udløbet (eller logget ud et andet sted): vis login igen – data bliver liggende til bagefter. */
const lost = () => useStore.setState({ authLost: true });

async function putFile(text: string) {
  try {
    const r = await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text });
    if (r.status === 401) { pending = text; lost(); return; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    setStatus({ mode: 'file', savedAt: new Date().toISOString(), error: undefined });
  } catch (e) {
    // Gem igen ved næste ændring – og sig det tydeligt.
    pending ??= text;
    setStatus({ mode: 'error', error: `Kunne ikke gemme (${(e as Error).message}). Kører serveren? Dine ændringer gemmes, så snart den svarer igen.` });
  }
}

export function flushSave() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (pending !== undefined) { const t = pending; pending = undefined; void putFile(t); }
}

// Gem det sidste, når fanen lukkes (sendBeacon overlever, at siden forsvinder – cookien følger med).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (pending !== undefined) navigator.sendBeacon('/api/data', new Blob([pending], { type: 'application/json' }));
    pending = undefined;
  });
}

/** Ældre versioner gemte en ukrypteret kopi i browseren – flyttes til den krypterede fil og slettes her. */
const LEGACY_KEY = 'finstate:v1';
const legacyLocal = () => { try { return localStorage.getItem(LEGACY_KEY); } catch { return null; } };
const dropLegacy = () => { try { localStorage.removeItem(LEGACY_KEY); } catch { /* ingen adgang */ } };

/**
 * Lagring: kun i den krypterede datafil via serveren (efter login). Intet gemmes i browseren.
 */
const fileStorage: StateStorage = {
  getItem: async () => {
    const info = await fetch('/api/storage', { cache: 'no-store' });
    if (info.status === 401) { lost(); throw new Error('Ikke logget ind'); }
    if (!info.ok) throw new Error((await info.json().catch(() => ({}))).error ?? `HTTP ${info.status}`);
    const meta = (await info.json()) as { dir: string; exists: boolean; savedAt?: string };
    setStatus({ mode: 'file', dir: meta.dir, savedAt: meta.savedAt, error: undefined });
    const local = legacyLocal();
    if (meta.exists) {
      const r = await fetch('/api/data', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      dropLegacy();
      return text;
    }
    // Ingen datafil endnu: flyt browserens gamle data over i den krypterede fil.
    if (local) { await putFile(local); dropLegacy(); }
    return local;
  },
  setItem: (_k, v) => {
    // Gem aldrig noget, før data er indlæst – ellers kunne en tom start overskrive filen.
    if (!hydrated) return;
    pending = v;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushSave, 400);
  },
  removeItem: () => {},
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
      // Data indlæses først efter login (se main.tsx).
      skipHydration: true,
      onRehydrateStorage: () => (_state, error) => { if (!error) hydrated = true; },
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

