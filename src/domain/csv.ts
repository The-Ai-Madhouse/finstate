import Papa from 'papaparse';
import { parseAmount, parseDate } from './format';
import type { ColumnMapping, TradeInfo, Tx } from './types';
import { hash } from './util';

/**
 * Dekoder en eksportfil. Rækkefølge:
 *  1. BOM: UTF-16 LE/BE (fx fra en netbroker) eller UTF-8
 *  2. UTF-16 uden BOM (mange nul-bytes på hver anden plads)
 *  3. UTF-8, ellers Windows-1252 (mange danske bankeksporter)
 */
export function decodeBytes(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let enc: string | undefined;
  if (b[0] === 0xff && b[1] === 0xfe) enc = 'utf-16le';
  else if (b[0] === 0xfe && b[1] === 0xff) enc = 'utf-16be';
  else if (b.length >= 4) {
    const n = Math.min(b.length, 400);
    let evenZero = 0, oddZero = 0;
    for (let i = 0; i < n; i++) if (b[i] === 0) (i % 2 ? oddZero++ : evenZero++);
    if (oddZero > n / 4 && evenZero < n / 20) enc = 'utf-16le';
    else if (evenZero > n / 4 && oddZero < n / 20) enc = 'utf-16be';
  }
  let text: string;
  if (enc) text = new TextDecoder(enc).decode(buf);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('windows-1252').decode(buf);
    }
  }
  return text.replace(/^﻿/, '');
}

/** Ligner filen en depot-/værdipapireksport ? */
export function isBrokerSheet(sheet: ParsedSheet): boolean {
  const h = sheet.header.map((c) => c.trim().toLowerCase());
  return h.includes('isin') || (h.includes('værdipapirer') && h.includes('transaktionstype'));
}

export interface ParsedSheet {
  header: string[];
  rows: string[][];
  headerSignature: string;
}

const HEADER_HINTS: Record<keyof ColumnMapping, RegExp> = {
  date: /^(bogf(ørings|orings)?dato|bogføringsdag|bogført|dato|date|posteringsdato|transaktionsdato|rentedato|handelsdag|handelsdato|trade date|booking date|valør(dato|dag)?)$/,
  text: /^(tekst|beskrivelse|text|description|posteringstekst|modtager|afsender|navn|meddelelse|title|transaktionstype|værdipapirer|værdipapir|transaktionstekst|instrument|køb\/salg|buy\/sell|handelstype)$/,
  amount: /^(beløb|belob|beløb i dkk|beløb \(dkk\)|amount|beløb dkk|amount \(dkk\)|booked amount|bogført beløb|afregningsbeløb|nettobeløb|net amount)$/,
  balance: /^(saldo|balance|saldo \(dkk\)|saldo i dkk|bogført saldo)$/,
  category: /^(kategori|category|hovedkategori)$/,
  subcategory: /^(underkategori|subcategory|sub-kategori)$/,
  note: /^(kommentar|note|notat|bemærkning|egen tekst|egen note)$/,
  accountName: /^(kontonavn|konto|account|account name|depot)$/,
  fee: /^(kurtage|courtage|commission|commissions|kommission|samlede afgifter|afgifter|gebyr|gebyrer|handelsgebyr|handelsomkostninger|transaktionsomkostninger|omkostninger|kurtage og gebyrer|kurtage \(dkk\)|kurtage dkk|fee|fees|total fees|trading fee|brokerage|brokerage fee)$/,
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function parseCsv(text: string): ParsedSheet {
  const res = Papa.parse<string[]>(text.trim(), { skipEmptyLines: 'greedy' });
  const all = res.data.filter((r) => r.some((c) => c.trim() !== ''));
  // Find headerrækken: første række med mindst to kendte kolonnenavne (nogle banker har metadata øverst).
  let hi = all.findIndex((r) => {
    const cells = r.map(norm);
    return Object.values(HEADER_HINTS).filter((re) => cells.some((c) => re.test(c))).length >= 2;
  });
  if (hi < 0) hi = 0;
  const header = all[hi].map((c) => c.trim());
  const rows = all.slice(hi + 1).filter((r) => r.length >= Math.min(3, header.length));
  return { header, rows, headerSignature: header.map(norm).join('|') };
}

export function guessMapping(sheet: ParsedSheet): Partial<ColumnMapping> {
  const h = sheet.header.map(norm);
  const find = (re: RegExp) => h.findIndex((c) => re.test(c));
  const m: Partial<ColumnMapping> = {};
  const d = find(HEADER_HINTS.date);
  if (d >= 0) m.date = d;
  const a = find(HEADER_HINTS.amount);
  if (a >= 0) m.amount = a;
  const b = find(HEADER_HINTS.balance);
  if (b >= 0) m.balance = b;
  // Nogle banker: "Hovedkategori" + "Kategori" = hoved- og underkategori.
  const hoved = h.indexOf('hovedkategori');
  const kat = h.indexOf('kategori');
  if (hoved >= 0) {
    m.category = hoved;
    if (kat >= 0) m.subcategory = kat;
  } else {
    const c = find(HEADER_HINTS.category);
    if (c >= 0) m.category = c;
  }
  const s = find(HEADER_HINTS.subcategory);
  if (s >= 0) m.subcategory = s;
  const n = find(HEADER_HINTS.note);
  if (n >= 0) m.note = n;
  const an = find(HEADER_HINTS.accountName);
  if (an >= 0) m.accountName = an;
  const fee = find(HEADER_HINTS.fee);
  if (fee >= 0 && fee !== m.amount) m.fee = fee;
  const texts = h.map((c, i) => (HEADER_HINTS.text.test(c) ? i : -1)).filter((i) => i >= 0);
  if (texts.length) m.text = texts;

  // Fallback på indhold, hvis headers er ukendte.
  const sample = sheet.rows.slice(0, 30);
  const col = (i: number) => sample.map((r) => r[i] ?? '');
  if (m.date === undefined) {
    const i = h.findIndex((_, i) => col(i).filter((v) => parseDate(v)).length > sample.length * 0.8);
    if (i >= 0) m.date = i;
  }
  if (m.amount === undefined) {
    const i = h.findIndex((_, i) => i !== m.date && i !== m.balance && col(i).filter((v) => parseAmount(v) !== null).length > sample.length * 0.8);
    if (i >= 0) m.amount = i;
  }
  if (!m.text) {
    // længste gennemsnitlige ikke-numeriske kolonne
    let best = -1, bestLen = 0;
    h.forEach((_, i) => {
      const vals = col(i);
      if (vals.some((v) => parseAmount(v) !== null && v.trim() !== '' && !/[a-zæøå]/i.test(v))) return;
      const len = vals.reduce((s, v) => s + v.length, 0) / Math.max(1, vals.length);
      if (len > bestLen) { bestLen = len; best = i; }
    });
    if (best >= 0) m.text = [best];
  }
  return m;
}

/** Første ikke-tomme værdi i kontonavn-kolonnen, fx "Min lønkonto". */
export function accountHint(sheet: ParsedSheet, m: Partial<ColumnMapping>): string | undefined {
  if (m.accountName === undefined) return undefined;
  return sheet.rows.map((r) => r[m.accountName!]?.trim()).find(Boolean);
}

export function isCompleteMapping(m: Partial<ColumnMapping>): m is ColumnMapping {
  return m.date !== undefined && m.amount !== undefined && !!m.text && m.text.length > 0;
}

export interface ImportPreview {
  txs: Tx[];
  errors: { row: number; reason: string }[];
  reversed: boolean;
}

/**
 * Bygger transaktioner. Id'et er en hash af konto, dato, beløb, tekst, saldo og
 * forekomstnummer – så samme eksport importeret to gange ikke giver dubletter.
 */
export function buildTxs(sheet: ParsedSheet, m: ColumnMapping, accountId: string): ImportPreview {
  const errors: ImportPreview['errors'] = [];
  const parsed: Omit<Tx, 'id' | 'seq' | 'importedAt'>[] = [];
  sheet.rows.forEach((r, idx) => {
    const date = parseDate(r[m.date] ?? '');
    const amount = parseAmount(r[m.amount] ?? '');
    if (!date || amount === null) {
      errors.push({ row: idx + 2, reason: !date ? `Ukendt dato "${r[m.date] ?? ''}"` : `Ukendt beløb "${r[m.amount] ?? ''}"` });
      return;
    }
    const text = m.text.map((i) => (r[i] ?? '').trim()).filter(Boolean).join(' · ');
    const balance = m.balance !== undefined ? parseAmount(r[m.balance] ?? '') ?? undefined : undefined;
    const note = m.note !== undefined ? r[m.note]?.trim() || undefined : undefined;
    const trade = tradeInfo(amount, text, m.fee !== undefined ? r[m.fee] : undefined);
    parsed.push({
      ...(note ? { note } : {}),
      ...(trade ? { trade } : {}),
      accountId,
      date,
      text,
      amount,
      balance,
      bankCategory: m.category !== undefined ? r[m.category]?.trim() || undefined : undefined,
      bankSubcategory: m.subcategory !== undefined ? r[m.subcategory]?.trim() || undefined : undefined,
    });
  });
  // Mange banker eksporterer nyeste først. Vend så rækkefølgen er kronologisk.
  const reversed = parsed.length > 1 && parsed[0].date > parsed[parsed.length - 1].date;
  if (reversed) parsed.reverse();
  const seen = new Map<string, number>();
  const now = new Date().toISOString();
  const txs: Tx[] = parsed.map((p, i) => {
    const base = `${accountId}|${p.date}|${p.amount}|${p.text}|${p.balance ?? ''}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...p, id: `tx-${hash(base + '|' + n)}`, seq: i, importedAt: now };
  });
  return { txs, errors, reversed };
}

// ------------------------------------------------------------------ kurtage

const num = (s?: string): number | null => {
  if (!s?.trim()) return null;
  const a = parseAmount(s);
  return a === null ? null : a / 100;
};

/** Kurtage i posteringsteksten: "… kurtage 29,00", "Kurt. 29", "commission: 1.50", "gebyr 15 kr". */
const FEE_IN_TEXT = /(?:kurtage|kurt\.|courtage|commission|kommission|handelsgebyr|gebyr)\s*[:=]?\s*(?:kr\.?|dkk)?\s*(\d(?:[\d.,]*\d)?)/i;
const BUY_SELL = /\b(køb|købt|buy|bought|purchase)\b|\b(salg|sælg|solgt|sell|sold|sale)\b/i;

/**
 * Finder kurtagen på en værdipapirhandel – fra en kurtagekolonne eller fra teksten.
 * Giver kun et resultat, når der faktisk er kurtage, og den er mindre end halvdelen af beløbet.
 */
export function tradeInfo(amount: number, text: string, feeCol?: string): TradeInfo | undefined {
  const total = Math.abs(amount);
  if (!total) return undefined;
  const bs = text.match(BUY_SELL);
  const side: TradeInfo['side'] = bs?.[2] ? 'sell' : bs?.[1] ? 'buy' : amount < 0 ? 'buy' : 'sell';
  const fee = num(feeCol) ?? num(text.match(FEE_IN_TEXT)?.[1]);
  const feeOre = fee !== null ? Math.round(Math.abs(fee) * 100) : 0;
  if (!feeOre || feeOre >= total * 0.5) return undefined;
  const gross = side === 'buy' ? total - feeOre : total + feeOre;
  return { fee: feeOre, gross, side };
}
