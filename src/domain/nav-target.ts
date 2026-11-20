/**
 * Navigation: hvilken side (og fane/periode) – og hvad der skal fremhæves, når man kommer dertil.
 * Ren domæne-kode (ingen browser), så både kontrollerne i engine.ts og brugerfladen bruger samme stavemåde.
 */

export type View = 'overview' | 'import' | 'ledger' | 'transfers' | 'balance' | 'statement' | 'slides' | 'settings' | 'versions' | 'budget';
export const VIEWS: View[] = ['overview', 'import', 'ledger', 'transfers', 'balance', 'statement', 'slides', 'settings', 'versions', 'budget'];
export const SETTINGS_TABS = ['accounts', 'categories', 'rules', 'bank', 'periods', 'data'] as const;

export const VIEW_LABEL: Record<View, string> = {
  overview: 'Overblik', import: 'Importér', ledger: 'Kategorisér', transfers: 'Overførsler', balance: 'Aktiver & passiver',
  statement: 'Regnskab', slides: 'Slideshow', settings: 'Indstillinger', versions: 'Versioner',
  budget: 'Abonnementer & regninger',
};

/** Det, der står i adresselinjen (#/side/fane?p=periode). */
export interface Route { view: View; tab?: string; periodId?: string }

/** Tilstand, modtagersiden skal sætte, før målet kan ses (folde ud, filtre, faneblad …). */
export interface FocusCtx {
  /** Aktiver & passiver: posten der foldes ud. */
  open?: string;
  /** Kategorisér: nulstil filtre (sorteringen bevares) og anvend evt. disse. */
  ledgerFilter?: { status?: 'all' | 'pending' | 'done' | 'uncat'; accountId?: string };
  /** Overførsler: filtre på listen over interne overførsler. */
  transfers?: { status?: 'missing' | 'transit' | 'all'; accountId?: string; onlyTx?: string };
  /** Overførsler → Afstemning: posten der foldes ud. */
  settle?: { postId?: string };
  /** Importér: vis saldokædens brud for kontoen. */
  breaks?: string;
}

/** Et mål: side + det element (data-focus-nøgle), der skal fremhæves. */
export interface NavTarget extends Route {
  /** Matcher data-focus="…" (flere nøgler pr. element adskilt af mellemrum). */
  key?: string;
  /** Kun det første element med nøglen (fx "første transaktion, der mangler afgørelse"). */
  first?: boolean;
  ctx?: FocusCtx;
  /** Hvorfor man er her – vises øverst på siden, fx kontrollens titel. */
  reason?: string;
}

export function encodeHash(r: Route): string {
  const path = r.view === 'settings' && r.tab ? `settings/${r.tab}` : r.view;
  return `#/${path}${r.periodId ? `?p=${encodeURIComponent(r.periodId)}` : ''}`;
}

/** Læs adresselinjen. Ukendte sider/faner ignoreres (→ undefined), så en gammel eller forkert adresse ikke giver fejl. */
export function decodeHash(hash: string): Route | undefined {
  const m = /^#\/([a-z]+)(?:\/([a-z]+))?(?:\?(.*))?$/.exec(hash);
  if (!m || !VIEWS.includes(m[1] as View)) return undefined;
  const view = m[1] as View;
  const tab = view === 'settings' && m[2] && (SETTINGS_TABS as readonly string[]).includes(m[2]) ? m[2] : undefined;
  const p = new URLSearchParams(m[3] ?? '').get('p') ?? undefined;
  return { view, ...(tab ? { tab } : {}), ...(p ? { periodId: p } : {}) };
}

export const sameRoute = (a: Route, b: Route) => a.view === b.view && (a.tab ?? '') === (b.tab ?? '') && (a.periodId ?? '') === (b.periodId ?? '');
