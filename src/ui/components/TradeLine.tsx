import { kr2f } from '../../domain/format';
import type { Category, Classification, Tx } from '../../domain/types';
import type { SplitPreset } from './SplitDialog';

/** Den kategori, kurtage nok hører til: "Kurtage", "Gebyrer", "Handelsomkostninger" … (udgift). */
export function feeCategory(categories: Category[]): string | undefined {
  const exp = categories.filter((c) => c.kind !== 'income');
  for (const re of [/kurtage|courtage/i, /handelsomkost|handelsgebyr|depotgebyr/i, /gebyr/i, /omkostning/i]) {
    const c = exp.find((x) => re.test(x.name));
    if (c) return c.id;
  }
  return undefined;
}

/**
 * Opdel en handel i købs-/salgsprisen og kurtagen. Køb: resten er prisen (det, transaktionen allerede er sat til,
 * fx Intern → depotet), kurtagen er en udgift. Salg: prisen er en del, og resten bliver kurtagen (en udgift).
 */
export function feeSplitPreset(tx: Tx, base: Classification, categories: Category[]): SplitPreset {
  const t = tx.trade!;
  const fee: Classification = { type: 'expense', categoryId: feeCategory(categories) };
  const what = t.quantity && t.price ? ` (${t.quantity} stk. à ${kr2f(t.price)})` : '';
  return t.side === 'buy' && tx.amount < 0
    ? { rest: base, parts: [{ cls: fee, amt: t.fee }], note: `Købsprisen ${kr2f(t.gross)} kr.${what} er resten – kurtagen ${kr2f(t.fee)} kr. er udfyldt som en udgift.` }
    : { rest: fee, parts: [{ cls: base, amt: t.gross }], note: `Salgsprisen ${kr2f(t.gross)} kr.${what} er udfyldt – resten er kurtagen ${kr2f(t.fee)} kr. (en udgift).` };
}

/** Under posteringsteksten: hvad handlen kostede, og hvad kurtagen var – med et tilbud om at opdele. */
export function TradeLine({ tx, split, onSplit }: { tx: Tx; split: boolean; onSplit?: () => void }) {
  const t = tx.trade!;
  return (
    <div className="trade-line small">
      <span className="trade-chip" title="Fundet i importfilen">Kurtage <b className="num">{kr2f(t.fee)}</b></span>
      <span className="muted">
        {t.side === 'buy' ? 'købspris' : 'salgspris'} <span className="num">{kr2f(t.gross)}</span>
        {t.quantity && t.price ? <> ({t.quantity} × {kr2f(t.price)})</> : null}
        {' · '}i alt <span className="num">{kr2f(Math.abs(tx.amount))}</span>
      </span>
      {onSplit && !split && <button className="linkish" onClick={onSplit} title="Åbn opdelingen med købsprisen og kurtagen udfyldt">Opdel kurtage…</button>}
    </div>
  );
}
