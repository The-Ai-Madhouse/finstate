import { useMemo } from 'react';
import { ruleFromTx, splitLines } from '../domain/classify';
import { buildEngine, type Engine } from '../domain/engine';
import type { AppData, BankMapEntry, Classification, Rule, Split, Tx } from '../domain/types';
import { uid } from '../domain/util';
import { update, useStore } from './store';

let last: { data: AppData; engine: Engine } | undefined;
export function getEngine(data: AppData): Engine {
  if (last?.data !== data) last = { data, engine: buildEngine(data) };
  return last.engine;
}
export function useEngine(): Engine {
  const data = useStore((s) => s.data);
  return useMemo(() => getEngine(data), [data]);
}

export function usePeriod() {
  const data = useStore((s) => s.data);
  const id = useStore((s) => s.periodId);
  const sorted = [...data.periods].sort((a, b) => (a.end < b.end ? 1 : -1));
  return sorted.find((p) => p.id === id) ?? sorted[0];
}

const mapTx = (ids: Set<string>, fn: (t: Tx) => Tx) => (d: AppData): AppData => ({
  ...d,
  txs: d.txs.map((t) => (ids.has(t.id) ? fn(t) : t)),
});

export function setManual(ids: string[], cls: Classification | undefined) {
  update(mapTx(new Set(ids), (t) => {
    const n = { ...t, manual: cls };
    if (cls) delete n.splits;
    return n;
  }));
}

/** Par to transaktioner som én intern overførsel (hver peger på den anden konto). */
export function pairTxs(aId: string, bId: string) {
  update((d) => {
    const a = d.txs.find((t) => t.id === aId), b = d.txs.find((t) => t.id === bId);
    if (!a || !b) return d;
    // Tidligere partnere mister deres parring.
    const old = new Set([a.pairWith, b.pairWith].filter((x): x is string => !!x && x !== aId && x !== bId));
    return {
      ...d,
      txs: d.txs.map((t) => {
        if (t.id === aId || t.id === bId) {
          const other = t.id === aId ? b : a;
          const n: Tx = { ...t, manual: { type: 'internal', targetAccountId: other.accountId }, pairWith: other.id };
          delete n.splits; delete n.noAutoPair;
          return n;
        }
        if (old.has(t.id)) { const n = { ...t }; delete n.pairWith; return n; }
        return t;
      }),
    };
  });
}

/** Ophæv en parring. En automatisk parring huskes som fravalgt, så den ikke kommer igen. */
export function unpairTxs(aId: string, bId: string) {
  update(mapTx(new Set([aId, bId]), (t) => {
    const n: Tx = { ...t, noAutoPair: true };
    delete n.pairWith;
    return n;
  }));
}

export function setSplits(id: string, splits: Split[] | undefined) {
  update(mapTx(new Set([id]), (t) => ({ ...t, splits })));
}

/**
 * Samme opdeling på flere transaktioner: faste beløb (med transaktionens fortegn) og resten til den første linje.
 * Er en transaktion mindre end de faste beløb, får den hele beløbet som "resten".
 */
export function applySplitTo(ids: string[], splits: NonNullable<Rule['splits']>) {
  const set = new Set(ids);
  update((d) => ({
    ...d,
    txs: d.txs.map((t) => {
      if (!set.has(t.id)) return t;
      const lines = splitLines(t, splits);
      if (lines.length === 1) {
        const { amount: _a, ...cls } = lines[0];
        void _a;
        return { ...t, manual: cls, splits: undefined };
      }
      return { ...t, splits: lines, manual: undefined };
    }),
  }));
}

/** Brugerens egen note – adskilt fra bankens kommentar (tx.note). */
export function setMemo(id: string, memo: string) {
  update(mapTx(new Set([id]), (t) => ({ ...t, memo: memo.trim() || undefined })));
}

/**
 * Gemmer en afgørelse som regel. Ryd samtidig manuelle valg på de transaktioner,
 * reglen nu dækker med samme resultat – så regler kan rettes ét sted senere.
 */
export function saveRule(sample: Tx, then: Classification, coveredIds: string[] = []) {
  const rule = ruleFromTx(sample, then, uid('rule'));
  const covered = new Set(coveredIds);
  update((d) => ({
    ...d,
    rules: [...d.rules.filter((r) => !(r.pattern === rule.pattern && r.match === 'exact' && r.sign === rule.sign && !r.accountId)), rule],
    txs: d.txs.map((t) => (covered.has(t.id) && !t.splits ? { ...t, manual: undefined } : t)),
  }));
  return rule;
}

export function upsertRule(rule: Rule) {
  update((d) => ({ ...d, rules: d.rules.some((r) => r.id === rule.id) ? d.rules.map((r) => (r.id === rule.id ? rule : r)) : [...d.rules, rule] }));
}
export function deleteRule(id: string) {
  update((d) => ({ ...d, rules: d.rules.filter((r) => r.id !== id) }));
}

export function setBankMap(key: string, entry: BankMapEntry | undefined) {
  update((d) => {
    const bankMap = { ...d.bankMap };
    if (entry) bankMap[key] = entry;
    else delete bankMap[key];
    return { ...d, bankMap };
  });
}

export function download(filename: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Hvad sletning af en post vil berøre – vises i advarslen. */
export function deleteImpact(d: AppData, accountId: string) {
  const usesTarget = (c?: { targetAccountId?: string }) => c?.targetAccountId === accountId;
  return {
    importedTxs: d.txs.filter((t) => t.accountId === accountId).length,
    valuations: d.valuations.filter((v) => v.accountId === accountId).length,
    openItems: d.openItems.filter((o) => o.accountId === accountId).length,
    txs: d.txs.filter((t) => usesTarget(t.manual) || t.splits?.some(usesTarget)).length,
    rules: d.rules.filter((r) => usesTarget(r.then) || r.splits?.some((s) => usesTarget(s.cls))).length,
  };
}

/**
 * Slet en post helt: dens værdier og startsaldo fjernes, transaktioner bogført til posten
 * nulstilles (så de kan afgøres igen), og regler der peger på posten fjernes.
 * Konti med importerede transaktioner slettes ikke her (slet importen først).
 */
export function deleteAccount(accountId: string) {
  update((d) => {
    if (d.txs.some((t) => t.accountId === accountId)) return d;
    const usesTarget = (c?: { targetAccountId?: string }) => c?.targetAccountId === accountId;
    return {
      ...d,
      accounts: d.accounts.filter((a) => a.id !== accountId),
      valuations: d.valuations.filter((v) => v.accountId !== accountId),
      openItems: d.openItems.filter((o) => o.accountId !== accountId),
      matches: (d.matches ?? []).filter((m) => m.accountId !== accountId),
      periods: d.periods.map((p) => (p.settle?.includes(accountId) ? { ...p, settle: p.settle.filter((id) => id !== accountId) } : p)),
      txs: d.txs.map((t) => (usesTarget(t.manual) || t.splits?.some(usesTarget) ? { ...t, manual: undefined, splits: undefined } : t)),
      rules: d.rules.filter((r) => !usesTarget(r.then) && !r.splits?.some((s) => usesTarget(s.cls))),
    };
  });
}

/**
 * Flyt en post i rækkefølgen. Med `before` flyttes den ind foran den post (træk-og-slip);
 * med `dir` byttes den med nabo-posten på samme side (aktiv/passiv).
 */
export function moveAccount(id: string, opts: { dir?: -1 | 1; before?: string; toEnd?: boolean }) {
  update((d) => {
    const list = [...d.accounts];
    const from = list.findIndex((a) => a.id === id);
    if (from < 0) return d;
    const acc = list[from];
    if (opts.toEnd) {
      list.splice(from, 1);
      let last = -1;
      list.forEach((a, i) => { if (a.side === acc.side) last = i; });
      list.splice(last + 1, 0, acc);
    } else if (opts.before) {
      if (opts.before === id) return d;
      list.splice(from, 1);
      const to = list.findIndex((a) => a.id === opts.before);
      list.splice(to < 0 ? list.length : to, 0, acc);
    } else if (opts.dir) {
      // Nærmeste synlige nabo på samme side i den ønskede retning.
      let j = from + opts.dir;
      while (j >= 0 && j < list.length && (list[j].side !== acc.side || list[j].archived)) j += opts.dir;
      if (j < 0 || j >= list.length) return d;
      [list[from], list[j]] = [list[j], list[from]];
    }
    return { ...d, accounts: list };
  });
}

/**
 * Husk en opdeling for samme tekst: faste beløb (positive øre) + én linje med "resten".
 * Opdelingen fjernes fra selve transaktionen, så reglen gælder ens for alle med samme tekst.
 */
export function saveSplitRule(sample: Tx, rest: Classification, fixed: { cls: Classification; amount: number }[]) {
  const base = ruleFromTx(sample, rest, uid('rule'));
  const rule: Rule = { ...base, splits: [{ cls: rest }, ...fixed.map((f) => ({ cls: f.cls, amount: Math.abs(f.amount) }))] };
  update((d) => ({
    ...d,
    rules: [...d.rules.filter((r) => !(r.pattern === rule.pattern && r.match === 'exact' && r.sign === rule.sign && !r.accountId)), rule],
    txs: d.txs.map((t) => (t.id === sample.id ? { ...t, splits: undefined, manual: undefined } : t)),
  }));
}
