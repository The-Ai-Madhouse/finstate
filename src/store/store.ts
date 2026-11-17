import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { emptyData } from '../domain/defaults';
import { inPeriod, withAutoBookStart } from '../domain/engine';
import { VIEW_LABEL, decodeHash, encodeHash, sameRoute, type NavTarget, type Route, type View } from '../domain/nav-target';
import type { TxFilter } from '../domain/txfilter';
import type { AppData } from '../domain/types';

export type { View, NavTarget } from '../domain/nav-target';

/** Det aktuelle mål for fremhævning. nonce: ny for hver navigation. quiet: kommer fra frem/tilbage – genskab, men fremhæv ikke igen. */
export type Focus = NavTarget & { nonce: number; quiet?: boolean };
/** Besked øverst på siden, når målet ikke kan vises (fx ligger før bogføringsstart) – evt. med en knap, der løser det. */
export interface NavNotice { text: string; action?: { label: string; run: () => void } }

/** Overførsler-mål: en overførsel (txId), en kontos overførsler (accountId) – eller Afstemning (settle) med en post, transaktion eller parring. */
export interface TransferFocus { accountId?: string; txId?: string; postId?: string; settle?: boolean; groupId?: string; status?: 'missing' | 'transit' | 'all'; reason?: string }

interface State {
  data: AppData;
  view: View;
  periodId?: string;
  /** Fane i Indstillinger (står i adresselinjen). */
  settingsTab?: string;
  /** Hvad der skal fremhæves på siden, man lige er kommet til ("Gå til", "Vis →" …). */
  focus?: Focus;
  navNotice?: NavNotice;
  setNavNotice: (n?: NavNotice) => void;
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
  /** Gå til en side (en ny post i browserens historik, så Tilbage virker). */
  setView: (v: View, settingsTab?: string) => void;
  /** Gå til et bestemt sted og fremhæv det. */
  goTo: (t: NavTarget, opts?: { replace?: boolean }) => void;
  /** Vis transaktionen i Kategorisér (skifter til dens financial statement). */
  showTx: (id: string, reason?: string) => void;
  showTransfers: (focus: TransferFocus) => void;
  /** Aktiver & passiver med posten foldet ud – evt. et bestemt felt (ultimo, opening, category …) eller en bevægelse. */
  showPost: (accountId: string, field?: string, reason?: string) => void;
  /** "Hører sammen med": transaktionen, man er ved at knytte til en anden (klik på den anden i listen). */
  linkPick?: LinkPick;
  setLinkPick: (pick?: LinkPick) => void;
  /** Valgt par, der venter på at blive bekræftet (og evt. hvor resten skal hen). */
  pairDraft?: { pick: LinkPick; otherId: string };
  setPairDraft: (draft?: { pick: LinkPick; otherId: string }) => void;
  /** Skift financial statement. replace: automatisk skift (fx efter sletning) – ingen ny post i historikken. */
  setPeriod: (id?: string, opts?: { replace?: boolean }) => void;
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
/** Det senest gemte indhold (så uændrede data ikke sendes igen). */
let lastWritten: string | undefined;

const setStatus = (patch: Partial<SaveStatus>) => {
  // useStore er defineret længere nede – kaldes først, når appen kører.
  const cur = useStore.getState().saveStatus;
  useStore.setState({ saveStatus: { ...cur, ...patch } });
};

/** Login er udløbet (eller logget ud et andet sted): vis login igen – data bliver liggende til bagefter. */
const lost = () => useStore.setState({ authLost: true });

/** Kun én gemning ad gangen – så en ældre gemning aldrig kan lande efter en nyere. */
let inFlight = false;

async function putFile(text: string) {
  inFlight = true;
  try {
    const r = await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text });
    // Gem altid den NYESTE tilstand igen (lastWritten) – aldrig den, der fejlede, hvis der er kommet nyere ændringer.
    if (r.status === 401) { pending = lastWritten ?? text; if (timer) clearTimeout(timer); timer = undefined; lost(); return; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    setStatus({ mode: 'file', savedAt: new Date().toISOString(), error: undefined });
  } catch (e) {
    pending = lastWritten ?? text;
    // Prøv igen om lidt – også selvom intet ændres i mellemtiden.
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushSave, 5000);
    setStatus({ mode: 'error', error: `Kunne ikke gemme (${(e as Error).message}). Kører serveren? Dine ændringer gemmes, så snart den svarer igen.` });
  } finally {
    inFlight = false;
    // Kom der ændringer, mens vi gemte, så gem dem nu (medmindre en genforsøg/debounce allerede venter).
    if (pending !== undefined && !timer && !useStore.getState().authLost) flushSave();
  }
}

export function flushSave() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (inFlight) return; // putFile gemmer det ventende, når den er færdig
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
    // Kun ved en reel ændring: persist kalder setItem ved ALLE ændringer i store (også gemmestatus og navigation),
    // og uden dette ville hver gemning udløse en ny gemning i ring.
    if (v === lastWritten) return;
    lastWritten = v;
    pending = v;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushSave, 400);
  },
  removeItem: () => {},
};

export const useStore = create<State>()(
  persist(
    (set, get) => ({
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
      setNavNotice: (navNotice) => set({ navNotice }),
      setView: (view, tab) => navigate({ view, tab, periodId: get().periodId }),
      goTo: (t, opts) => navigate({ view: t.view, tab: t.tab, periodId: t.periodId ?? get().periodId }, t.key || t.ctx || t.reason ? t : undefined, opts?.replace),
      setPeriod: (periodId, opts) => navigate({ view: get().view, tab: get().settingsTab, periodId }, undefined, opts?.replace),
      showTx: (id, reason) => {
        const { data, periodId } = get();
        const t = data.txs.find((x) => x.id === id);
        const cur = data.periods.find((p) => p.id === periodId);
        // Ligger transaktionen i et andet financial statement, så skift til det.
        const pid = t && cur && inPeriod(t, cur) ? periodId : (t && data.periods.find((p) => inPeriod(t, p))?.id) ?? periodId;
        get().goTo({ view: 'ledger', periodId: pid, key: `tx:${id}`, ctx: { ledgerFilter: {} }, reason });
        if (t && t.date <= data.settings.bookStart) set({ navNotice: { text: `Transaktionen (${t.date}) ligger før bogføringsstart (${data.settings.bookStart}) og vises derfor ikke i Kategorisér.` } });
      },
      showTransfers: (f) => {
        const { data, periodId } = get();
        const t = f.txId ? data.txs.find((x) => x.id === f.txId) : undefined;
        const cur = data.periods.find((p) => p.id === periodId);
        const pid = t && cur && !inPeriod(t, cur) ? data.periods.find((p) => inPeriod(t, p))?.id ?? periodId : periodId;
        if (f.settle) {
          const key = f.txId ? `settle:item:${f.txId}` : f.groupId ? `settle:group:${f.groupId}` : f.postId ? `settle:post:${f.postId}` : 'settle:card';
          get().goTo({ view: 'transfers', periodId: pid, key, ctx: { settle: { postId: f.postId } }, reason: f.reason });
        } else if (f.txId) {
          get().goTo({ view: 'transfers', periodId: pid, key: `xfer:${f.txId}`, ctx: { transfers: { onlyTx: f.txId, status: 'all' } }, reason: f.reason });
        } else {
          get().goTo({ view: 'transfers', key: 'xfer:card', ctx: { transfers: { accountId: f.accountId, status: f.status ?? 'all' } }, reason: f.reason });
        }
      },
      showPost: (id, field, reason) => get().goTo({ view: 'balance', key: field ? `post:${id}:${field}` : `post:${id}`, ctx: { open: id }, reason }),
      setLinkPick: (linkPick) => set({ linkPick }),
      setPairDraft: (pairDraft) => set({ pairDraft }),
    }),
    {
      name: KEY,
      version: 1,
      storage: createJSONStorage(() => fileStorage),
      // Data indlæses først efter login (se main.tsx).
      skipHydration: true,
      onRehydrateStorage: () => (_state, error) => { if (!error) hydrated = true; },
      // Siden står i adresselinjen (frem/tilbage og genindlæsning) – kun data og valgt financial statement gemmes.
      partialize: (s) => ({ data: s.data, periodId: s.periodId }),
      // Nye felter i fremtidige versioner får standardværdier.
      merge: (persisted, current) => {
        const p = persisted as Partial<State> | undefined;
        if (!p?.data) return current;
        // Ældre filer har også gemt siden (view) – den kommer nu fra adresselinjen.
        return { ...current, periodId: p.periodId, data: withAutoBookStart({ ...emptyData(), ...p.data, settings: { ...emptyData().settings, ...p.data.settings } }) };
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


// ------------------------------------------------------------------ Browserhistorik (frem/tilbage)

interface HistState { v: 1; id?: string; route: Route; focus?: NavTarget; scroll?: number }

let nonce = 0;
let historyOn = false;
let entrySeq = 0;
const newEntryId = () => `${Date.now().toString(36)}-${++entrySeq}`;
/** Seneste scroll-position pr. historikpost (opdateres ved hver scroll – så også et hurtigt Tilbage husker den). */
const scrollById = new Map<string, number>();

/** Det element, der scroller: hovedområdet på store skærme, ellers hele siden. */
function scroller(): HTMLElement {
  const m = document.querySelector<HTMLElement>('.main');
  if (m && m.scrollHeight > m.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(m).overflowY)) return m;
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

const titleFor = (r: Route) => `Finstate – ${VIEW_LABEL[r.view]}`;

/**
 * Skift side og/eller fremhæv noget. Ny side → ny post i historikken (Tilbage virker);
 * samme side med et nyt mål → erstat posten; samme side uden mål → ingenting.
 */
function navigate(next: Route, focus?: NavTarget, replace = false) {
  const s = useStore.getState();
  const cur: Route = { view: s.view, tab: s.settingsTab, periodId: s.periodId };
  if (next.view !== 'settings') next = { ...next, tab: undefined };
  const rawChanged = !sameRoute(cur, next);
  // Det, man faktisk ser: et ukendt/tomt financial statement vises som det nyeste (samme regel som usePeriod).
  const shown = (id?: string) => {
    const sorted = [...s.data.periods].sort((a, b) => (a.end < b.end ? 1 : -1));
    return (sorted.find((p) => p.id === id) ?? sorted[0])?.id;
  };
  const visibleChanged = cur.view !== next.view || (cur.tab ?? '') !== (next.tab ?? '') || shown(cur.periodId) !== shown(next.periodId);
  if (!rawChanged && !focus) return;
  // Ingen synlig ændring (fx vælge det financial statement, der allerede vises): skriv det i adressen, men lav ingen ny post.
  const changed = visibleChanged;
  const push = changed && !replace;
  if (historyOn && push) rememberScroll();
  useStore.setState({
    view: next.view, settingsTab: next.tab, periodId: next.periodId,
    focus: focus ? { ...focus, view: next.view, nonce: ++nonce } : undefined,
    navNotice: undefined,
    ...(next.view !== cur.view ? { linkPick: undefined } : {}),
  });
  if (!historyOn) return;
  const prevId = (history.state as HistState | null)?.id;
  const st: HistState = { v: 1, id: push ? newEntryId() : prevId ?? newEntryId(), route: next, focus: focus && JSON.parse(JSON.stringify(focus)) };
  if (push) history.pushState(st, '', encodeHash(next));
  else history.replaceState(st, '', encodeHash(next));
  document.title = titleFor(next);
  // Ny side starter øverst – medmindre der er et mål, som der rulles hen til.
  if (push && !focus?.key) requestAnimationFrame(() => scroller().scrollTo(0, 0));
}

/** Husk, hvor langt nede man er, i den aktuelle historikpost (så Tilbage lander samme sted). */
function rememberScroll() {
  const st = history.state as HistState | null;
  if (st?.v === 1) history.replaceState({ ...st, scroll: scroller().scrollTop }, '');
}

let scrollTimer: ReturnType<typeof setTimeout> | undefined;
const onScroll = () => {
  const id = (history.state as HistState | null)?.id;
  if (id) scrollById.set(id, scroller().scrollTop);
  // Også i selve historikposten (overlever genindlæsning) – men sjældent, da browsere begrænser replaceState.
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(rememberScroll, 250);
};

function restoreScroll(y: number) {
  const go = () => scroller().scrollTo(0, y);
  requestAnimationFrame(() => requestAnimationFrame(go));
  // Siden kan vokse lidt efter første tegning (fx når en post er foldet ud igen).
  setTimeout(go, 150);
}

/** Frem/tilbage: vis siden igen – med samme kontekst (fx den udfoldede post), men uden ny fremhævning. */
function onPop(ev: PopStateEvent) {
  // En ventende gemning af scroll-position hører til posten, vi forlader – ikke den, vi kommer til.
  if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = undefined; }
  const raw: HistState = (ev.state as HistState | null)?.v === 1 ? ev.state : { v: 1, route: decodeHash(location.hash) ?? { view: 'overview' } };
  const s = useStore.getState();
  // Et financial statement, der er slettet siden, kan ikke vises igen – brug det aktuelle (hvis det findes).
  const known = (id?: string) => !!id && s.data.periods.some((p) => p.id === id);
  const periodId = known(raw.route.periodId) ? raw.route.periodId : known(s.periodId) ? s.periodId : undefined;
  const st: HistState = { ...raw, id: raw.id ?? newEntryId(), route: { ...raw.route, periodId } };
  if (!sameRoute(st.route, raw.route) || !raw.id) history.replaceState(st, '', encodeHash(st.route));
  useStore.setState({
    view: st.route.view, settingsTab: st.route.tab, periodId,
    focus: st.focus ? { ...st.focus, nonce: ++nonce, quiet: true } : undefined,
    navNotice: undefined, linkPick: undefined,
  });
  document.title = titleFor(st.route);
  restoreScroll((st.id ? scrollById.get(st.id) : undefined) ?? st.scroll ?? 0);
}

/** Kaldes, når data er indlæst: adresselinjen bestemmer siden (ellers Overblik), og frem/tilbage slås til. */
export function initHistory() {
  if (historyOn || typeof window === 'undefined') return;
  historyOn = true;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const s = useStore.getState();
  const url = decodeHash(location.hash);
  const periodId = url?.periodId && s.data.periods.some((p) => p.id === url.periodId) ? url.periodId : s.periodId;
  const route: Route = { view: url?.view ?? 'overview', tab: url?.tab, periodId };
  useStore.setState({ view: route.view, settingsTab: route.tab, periodId: route.periodId });
  history.replaceState({ v: 1, id: newEntryId(), route } satisfies HistState, '', encodeHash(route));
  document.title = titleFor(route);
  window.addEventListener('popstate', onPop);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
}
