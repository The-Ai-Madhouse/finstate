/**
 * Normaliserer en posteringstekst, så gentagne poster genkendes på tværs af datoer,
 * notanumre og kortreferencer: "Dankort-nota Købmand Hansen 1234 13.05" → "købmand hansen".
 */
const NOISE = [
  /\b(visa\/dankort|visa|dankort|mastercard|mc)[- ]?(nota|køb|kob)?\b/g,
  /\bdk[- ]?nota\b/g,
  /^vd\b/g, // "VD" = Visa/Dankort i nogle bankers eksport
  /\bnota(nr\.?|nummer)?\b/g,
  /\bkortkøb\b/g,
  /\bvaluta\b|\bkurs\b/g,
  /\b(dkk|eur|sek|nok|usd|gbp)\b/g,
];

export function normalizeText(text: string): string {
  let s = text.toLowerCase();
  s = s.replace(/\b\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?\b/g, ' '); // datoer
  for (const re of NOISE) s = s.replace(re, ' ');
  s = s.replace(/[0-9]+/g, ' '); // numre, referencer
  s = s.replace(/[^a-zæøåäöüé&]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function isMobilePay(text: string): boolean {
  return /mobile ?pay|\bmp\b/i.test(text);
}

const titleCase = (s: string) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

/** Udleder modpart (person) fra fx "MobilePay: Jonas Lind" eller "Overførsel fra Ida Krogh". */
export function guessCounterparty(text: string): string {
  let s = text.replace(/\b\d[\d .:/-]*\b/g, ' ');
  const mp = s.match(/mobile ?pay[:\s-]*(.*)/i);
  if (mp && mp[1].trim()) s = mp[1];
  else {
    const fra = s.match(/\b(?:overførsel|overf\.?)?\s*(?:fra|til)\s+(.*)/i);
    if (fra && fra[1].trim()) s = fra[1];
  }
  s = s.replace(/[^A-Za-zÆØÅæøåÄÖÜäöüÉé\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? titleCase(s) : 'Ukendt';
}
