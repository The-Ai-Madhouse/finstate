const kr0 = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 });
const kr2 = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 1 });

/** 1234567 øre → "12.346 kr" */
export const kr = (ore: number) => `${kr0.format(Math.round(ore / 100) || 0)} kr`;
/** 1234567 øre → "12.345,67" */
export const kr2f = (ore: number) => kr2.format(ore / 100 || 0);
export const signedKr = (ore: number) => {
  const r = Math.round(ore / 100);
  return (r > 0 ? '+' : r < 0 ? '−' : '') + kr(Math.abs(ore));
};
export const pctf = (x: number) => `${pct.format(x * 100)} %`;

const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
export const dateDa = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}. ${months[Number(m) - 1]} ${y}`;
};
export const dateShort = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y.slice(2)}`;
};

/** Parser brugerindtastet beløb i kr ("1.234,5", "-200", "1234.50") → øre. */
export function parseKrInput(s: string): number | null {
  const n = parseAmount(s);
  return n;
}

/**
 * Parser et beløb i dansk eller engelsk notation til øre.
 * "1.234,56" → 123456, "-1234,5" → -123450, "1,234.56" → 123456, "1.234" → 123400
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/\s|kr\.?|dkk/gi, '').replace(/[−–]/g, '-');
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = /,\d{3}$/.test(s) && (s.match(/,/g)!.length > 1) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
  } else if (lastDot >= 0) {
    const dots = s.match(/\./g)!.length;
    normalized = dots > 1 || /\.\d{3}$/.test(s) ? s.replace(/\./g, '') : s;
  } else normalized = s;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const v = Math.round(parseFloat(normalized) * 100);
  return neg ? -v : v;
}

/** Parser dato i almindelige bankformater til ISO. */
export function parseDate(raw: string): string | null {
  const s = raw.trim().split(/[ T]/)[0];
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return iso(y, +m[2], +m[1]);
  }
  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
