import { kr, pctf, signedKr } from './format';
import type { CatTotal, Statement } from './ledger';

export interface CatDelta {
  id: string;
  name: string;
  now: number;
  prev: number;
  delta: number;
  rel: number | null;
}

export function catDeltas(now: CatTotal[], prev?: CatTotal[]): CatDelta[] {
  const p = new Map((prev ?? []).map((c) => [c.id, c.amount]));
  const ids = new Set([...now.map((c) => c.id), ...(prev ?? []).map((c) => c.id)]);
  const names = new Map([...(prev ?? []), ...now].map((c) => [c.id, c.name]));
  return [...ids]
    .map((id) => {
      const n = now.find((c) => c.id === id)?.amount ?? 0;
      const pv = p.get(id) ?? 0;
      return { id, name: names.get(id)!, now: n, prev: pv, delta: n - pv, rel: pv ? (n - pv) / Math.abs(pv) : null };
    })
    .filter((d) => d.now || d.prev);
}

export interface KeyFigures {
  netWorth: number;
  netWorthDelta: number;
  netWorthRel: number | null;
  income: number;
  expense: number;
  result: number;
  savingsRate: number | null;
  debt: number;
  receivables: number;
}

export function keyFigures(s: Statement): KeyFigures {
  const delta = s.equityClose - s.equityOpen;
  return {
    netWorth: s.equityClose,
    netWorthDelta: delta,
    netWorthRel: s.equityOpen ? delta / Math.abs(s.equityOpen) : null,
    income: s.incomeTotal,
    expense: s.expenseTotal,
    result: s.result,
    savingsRate: s.incomeTotal > 0 ? s.result / s.incomeTotal : null,
    debt: s.liabClose,
    receivables: s.rows.filter((r) => (r.kind === 'cp' || r.kind === 'tracked') && r.close > 0).reduce((t, r) => t + r.close, 0),
  };
}

const MIN_ABS = 50000; // 500 kr – mindre ændringer er støj
const MIN_REL = 0.1;
const significant = (d: CatDelta) => Math.abs(d.delta) >= MIN_ABS && (d.rel === null || Math.abs(d.rel) >= MIN_REL);
const relTxt = (d: CatDelta) => (d.rel === null ? 'ny' : `${d.rel > 0 ? '+' : ''}${pctf(d.rel)}`);

export interface Narrative {
  summary: string;
  progress: string[];
  setbacks: string[];
  incomeComment: string;
  expenseComment: string;
  balanceComment: string;
}

/** Regelbaserede forslag til kommentarer. Brugeren retter dem til i slideshowet. */
export function narrative(now: Statement, prev?: Statement): Narrative {
  const k = keyFigures(now);
  const kp = prev ? keyFigures(prev) : undefined;
  const progress: string[] = [];
  const setbacks: string[] = [];

  (k.netWorthDelta >= 0 ? progress : setbacks).push(
    `Nettoformuen ${k.netWorthDelta >= 0 ? 'steg' : 'faldt'} med ${kr(Math.abs(k.netWorthDelta))}${k.netWorthRel !== null ? ` (${pctf(k.netWorthRel)})` : ''} til ${kr(k.netWorth)}.`,
  );
  if (kp && k.savingsRate !== null && kp.savingsRate !== null) {
    const d = k.savingsRate - kp.savingsRate;
    if (Math.abs(d) >= 0.03)
      (d > 0 ? progress : setbacks).push(`Opsparingsraten gik fra ${pctf(kp.savingsRate)} til ${pctf(k.savingsRate)}.`);
  }
  if (kp && Math.abs(k.debt - kp.debt) >= MIN_ABS)
    (k.debt < kp.debt ? progress : setbacks).push(`Gælden ${k.debt < kp.debt ? 'faldt' : 'steg'} med ${kr(Math.abs(k.debt - kp.debt))} til ${kr(k.debt)}.`);

  const inc = catDeltas(now.income, prev?.income).filter(significant).sort((a, b) => b.delta - a.delta);
  const exp = catDeltas(now.expense, prev?.expense).filter(significant).sort((a, b) => a.delta - b.delta);
  if (prev) {
    for (const d of inc.filter((d) => d.delta > 0).slice(0, 2)) progress.push(`Mere i ${d.name}: ${signedKr(d.delta)} (${relTxt(d)}).`);
    for (const d of inc.filter((d) => d.delta < 0).slice(-2).reverse()) setbacks.push(`Mindre i ${d.name}: ${signedKr(d.delta)} (${relTxt(d)}).`);
    for (const d of exp.filter((d) => d.delta < 0).slice(0, 2)) progress.push(`Brugte mindre på ${d.name}: ${signedKr(d.delta)} (${relTxt(d)}).`);
    for (const d of exp.filter((d) => d.delta > 0).slice(-2).reverse()) setbacks.push(`Brugte mere på ${d.name}: ${signedKr(d.delta)} (${relTxt(d)}).`);
  }
  if (k.receivables >= MIN_ABS) setbacks.push(`Andre skylder mig stadig ${kr(k.receivables)} i udlæg.`);

  const topExp = [...now.expense].sort((a, b) => b.amount - a.amount).slice(0, 3);
  const topInc = [...now.income].sort((a, b) => b.amount - a.amount).slice(0, 2);
  const share = (x: number, t: number) => (t ? pctf(x / t) : '–');

  const summary =
    `${now.period.name}: indtægter ${kr(k.income)}, udgifter ${kr(k.expense)} – ` +
    `${k.result >= 0 ? 'overskud' : 'underskud'} på ${kr(Math.abs(k.result))}` +
    (k.savingsRate !== null ? ` (opsparingsrate ${pctf(k.savingsRate)})` : '') +
    (kp ? `. Sidste periode: ${kp.result >= 0 ? 'overskud' : 'underskud'} på ${kr(Math.abs(kp.result))}.` : '.');

  return {
    summary,
    progress,
    setbacks,
    incomeComment: topInc.length
      ? `Største indtægtskilder: ${topInc.map((c) => `${c.name} (${share(c.amount, k.income)})`).join(', ')}.`
      : '',
    expenseComment: topExp.length
      ? `Største udgiftsposter: ${topExp.map((c) => `${c.name} ${kr(c.amount)} (${share(c.amount, k.expense)})`).join(', ')}.`
      : '',
    balanceComment: `Aktiver ${kr(now.assetsClose)} og gæld ${kr(now.liabClose)} giver en egenkapital på ${kr(now.equityClose)}.`,
  };
}
