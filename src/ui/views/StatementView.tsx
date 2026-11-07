import { NoPeriod } from '../components/PeriodPrompt';
import { useState } from 'react';
import { comparePeriod, inPeriod } from '../../domain/engine';
import { kr, kr2f, pctf, signedKr } from '../../domain/format';
import { cashflow, isPassive, perMonth, type Cashflow } from '../../domain/cashflow';
import { noteFor, typeName } from '../../domain/accountTypes';
import { valuationResultInPeriod, type BsRow, type CatTotal, type Statement } from '../../domain/ledger';
import { TX_TYPE_LABEL } from '../../domain/types';
import { download, useEngine, usePeriod } from '../../store/actions';
import { useData, useStore } from '../../store/store';
import { BarCompare } from '../components/charts';
import { SourcesDialog } from '../components/SourcesDialog';
import { Money, ResultParts } from '../components/common';

export function StatementView() {
  const e = useEngine();
  const period = usePeriod();
  const update = useStore((s) => s.update);
  const [compare, setCompare] = useState(false);
  if (!period) return <NoPeriod />;
  const { data } = e;
  const s = e.statement(period);
  const prevP = comparePeriod(data, period);
  const prev = prevP ? e.statement(prevP) : undefined;

  const exportTx = () => {
    const rows = [['Dato', 'Konto', 'Tekst', 'Beløb', 'Saldo', 'Type', 'Kategori', 'Hovedkategori', 'Modpart/konto', 'Kilde', 'Bankens kommentar', 'Din note']];
    for (const t of data.txs.filter((t) => inPeriod(t, period)).sort((a, b) => (a.date < b.date ? -1 : 1))) {
      const r = e.resolved.get(t.id)!;
      for (const l of r.lines) {
        const cat = data.categories.find((c) => c.id === l.categoryId);
        const top = cat?.parentId ? data.categories.find((c) => c.id === cat.parentId) : cat;
        rows.push([
          t.date, data.accounts.find((a) => a.id === t.accountId)?.name ?? '', t.text, kr2f(l.amount), t.balance !== undefined ? kr2f(t.balance) : '',
          TX_TYPE_LABEL[l.type], cat?.name ?? '', top?.name ?? '', l.counterparty ?? data.accounts.find((a) => a.id === l.targetAccountId)?.name ?? '', r.source, t.note ?? '', t.memo ?? '',
        ]);
      }
    }
    download(`finstate-transaktioner-${period.name}.csv`, '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n'), 'text/csv');
  };

  const exportStatement = () => {
    const rows: string[][] = [['Sektion', 'Post', 'Underpost', period.name, prevP?.name ?? '']];
    const cats = (title: string, now: CatTotal[], pv?: CatTotal[]) => {
      for (const c of now) {
        rows.push([title, c.name, '', kr2f(c.amount), pv ? kr2f(pv.find((x) => x.id === c.id)?.amount ?? 0) : '']);
        for (const ch of c.children) rows.push([title, c.name, ch.name, kr2f(ch.amount), pv ? kr2f(pv.find((x) => x.id === c.id)?.children.find((y) => y.id === ch.id)?.amount ?? 0) : '']);
      }
    };
    cats('Indtægter', s.income, prev?.income);
    cats('Udgifter', s.expense, prev?.expense);
    rows.push(['Resultat', '', '', kr2f(s.result), prev ? kr2f(prev.result) : '']);
    for (const r of s.rows) rows.push([r.side === 'asset' ? 'Aktiver' : 'Passiver', r.label, 'ultimo', kr2f(Math.abs(r.close)), '']);
    rows.push(['Egenkapital', 'Primo', '', kr2f(s.equityOpen), '']);
    rows.push(['Egenkapital', 'Ultimo', '', kr2f(s.equityClose), '']);
    download(`finstate-regnskab-${period.name}.csv`, '﻿' + rows.map((r) => r.map((c) => `"${c}"`).join(';')).join('\n'), 'text/csv');
  };

  const cf = cashflow(s, data.categories);
  const cfPrev = prev ? cashflow(prev, data.categories) : undefined;
  const compareTo = compare && prev ? { s: prev, cf: cfPrev!, name: prevP!.name } : undefined;

  return (
    <div className="stack">
      <div className="row">
        <h1>Regnskab {period.name}</h1>
        <span className="spacer" />
        <label className="row small ink2">
          <input type="checkbox" checked={compare} disabled={!prev} onChange={(ev) => setCompare(ev.target.checked)} /> Sammenlign pr. måned med
        </label>
        <select className="sm" value={period.compareToId ?? ''} onChange={(ev) => update((d) => ({ ...d, periods: d.periods.map((p) => (p.id === period.id ? { ...p, compareToId: ev.target.value || undefined } : p)) }))}>
          <option value="">Automatisk{prevP && !period.compareToId ? ` (${prevP.name})` : ''}</option>
          {data.periods.filter((p) => p.id !== period.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn sm" onClick={exportStatement}>Eksportér regnskab (CSV)</button>
        <button className="btn sm" onClick={exportTx}>Eksportér transaktioner (CSV)</button>
      </div>

      <div className="fs-grid">
        <section className="fs-card">
          <h2 className="fs-title">Resultatopgørelse</h2>
          <PlSection title="Indtægter" kind="income" now={s.income} uncat={s.uncategorized.income} total={s.incomeTotal} months={cf.months} compareTo={compareTo} />
          <PlSection title="Udgifter" kind="expense" now={s.expense} uncat={s.uncategorized.expense} total={s.expenseTotal} months={cf.months} compareTo={compareTo} />
        </section>
        <Summary s={s} cf={cf} cfPrev={compareTo ? cfPrev : undefined} prevName={prevP?.name} />
      </div>

      <section className="fs-card">
        <h2 className="fs-title">Balance <span className="small muted" style={{ fontWeight: 400 }}>pr. {period.end}</span></h2>
        <BalanceColumns s={s} />
      </section>

      <div className="grid2">
        <div className="card"><h2>Udgifter pr. kategori</h2><BarCompare rows={rowsFor(s.expense, prev?.expense)} nowLabel={period.name} prevLabel={prevP?.name} /></div>
        <div className="card"><h2>Indtægter pr. kategori</h2><BarCompare rows={rowsFor(s.income, prev?.income)} nowLabel={period.name} prevLabel={prevP?.name} /></div>
      </div>
      <p className="small muted row">
        Kontrol: egenkapital primo {kr(s.equityOpen)} + resultat {kr(s.result)}{s.openingInPeriod ? ` + åbningsposter ${kr(s.openingInPeriod)}` : ''} = ultimo {kr(s.equityClose)}{' '}
        {s.equityOpen + s.result + s.openingInPeriod === s.equityClose ? <span className="pos">✓ går op</span> : <span className="neg">✗ går ikke op</span>}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => useStore.getState().setView('settings', 'categories')}>Rediger kategorier →</button>
      </p>
    </div>
  );
}

export function rowsFor(now: CatTotal[], prev?: CatTotal[]) {
  const ids = new Set([...now, ...(prev ?? [])].filter((c) => c.amount).map((c) => c.id));
  return [...ids]
    .map((id) => ({ label: (now.find((c) => c.id === id) ?? prev!.find((c) => c.id === id))!.name, now: now.find((c) => c.id === id)?.amount ?? 0, prev: prev?.find((c) => c.id === id)?.amount ?? 0 }))
    .sort((a, b) => b.now - a.now || b.prev - a.prev);
}

const fmtMonths = (m: number) => new Intl.NumberFormat('da-DK', { maximumFractionDigits: 2 }).format(m);

type CompareTo = { s: Statement; cf: Cashflow; name: string };

/** Indtægter eller udgifter: Beskrivelse | I perioden | Pr. måned (+ evt. sammenligning pr. måned). */
function PlSection({ title, kind, now, uncat, total, months, compareTo }: {
  title: string; kind: 'income' | 'expense'; now: CatTotal[]; uncat: number; total: number; months: number; compareTo?: CompareTo;
}) {
  const { categories } = useData();
  const update = useStore((st) => st.update);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const prevList = compareTo ? (kind === 'income' ? compareTo.s.income : compareTo.s.expense) : undefined;
  const pm = (v: number) => perMonth(v, months);
  const ppm = (id: string, sub?: string) => {
    if (!prevList || !compareTo) return 0;
    const c = prevList.find((x) => x.id === id);
    const v = sub ? c?.children.find((x) => x.id === sub)?.amount ?? 0 : c?.amount ?? 0;
    return perMonth(v, compareTo.cf.months);
  };
  const delta = (cur: number, before: number) => {
    const d = cur - before;
    const good = kind === 'income' ? d >= 0 : d <= 0;
    return <span className={Math.abs(d) < 50 ? 'muted' : good ? 'pos' : 'neg'}><Money v={d} signed /></span>;
  };
  const togglePassive = (id: string) => update((d) => ({ ...d, categories: d.categories.map((c) => (c.id === id ? { ...c, passive: !isPassive(d.categories, id) } : c)) }));
  const visible = now.filter((c) => c.amount || (prevList && prevList.find((x) => x.id === c.id)?.amount));
  const period = usePeriod()!;
  const [sources, setSources] = useState<{ title: string; refs: Set<string> }>();
  /** Klikbart beløb → "Hvor kommer det fra?" */
  const amountLink = (v: number, title: string, ids: string[]) => (
    <button className="amount-link" title="Se hvor beløbet kommer fra" onClick={(ev) => { ev.stopPropagation(); setSources({ title, refs: new Set(ids) }); }}>
      <Money v={v} />
    </button>
  );
  const prevTotal = compareTo ? (kind === 'income' ? compareTo.s.incomeTotal : compareTo.s.expenseTotal) : 0;
  const passiveChip = (id: string) =>
    (
      <button className={`chip passive-chip ${kind} ${isPassive(categories, id) ? 'on' : ''}`}
        title={kind === 'income'
          ? 'Passiv indkomst = penge der arbejder for dig (renter, afkast, udbytte …). Klik for at ændre.'
          : 'Passiv udgift = fast udgift der løber af sig selv (abonnementer, husleje, transportkort …). Klik for at markere.'}
        onClick={(ev) => { ev.stopPropagation(); togglePassive(id); }}>
        passiv
      </button>
    );
  return (
    <div className="fs-section">
      <div className="fs-bar">{title}</div>
      <table className="fs-table">
        <thead>
          <tr>
            <th>Beskrivelse</th><th className="num">I perioden</th><th className="num">Pr. måned</th>
            {compareTo && <><th className="num">{compareTo.name} pr. md.</th><th className="num">Ændring pr. md.</th></>}
          </tr>
        </thead>
        <tbody>
          {visible.flatMap((c) => {
            const kids = c.children.filter((x) => x.amount || ppm(c.id, x.id));
            const isOpen = open.has(c.id);
            const rows = [
              <tr key={c.id} className={kids.length ? 'click' : ''} onClick={() => kids.length && setOpen(new Set(isOpen ? [...open].filter((x) => x !== c.id) : [...open, c.id]))}>
                <td>{kids.length ? <span className="caret">{isOpen ? '▾' : '▸'}</span> : <span className="caret" />}{c.name} {passiveChip(c.id)}</td>
                <td className="num">{amountLink(c.amount, c.name, [c.id, ...c.children.map((k) => k.id)].map((id) => `cat:${id}`))}</td>
                <td className="num"><b><Money v={pm(c.amount)} /></b></td>
                {compareTo && <><td className="num muted"><Money v={ppm(c.id)} /></td><td className="num">{delta(pm(c.amount), ppm(c.id))}</td></>}
              </tr>,
            ];
            if (isOpen) for (const k of kids) rows.push(
              <tr key={c.id + k.id} className="sub">
                <td>{k.name} {passiveChip(k.id)}</td>
                <td className="num">{amountLink(k.amount, k.id === c.id ? c.name : `${c.name} › ${k.name}`, [`cat:${k.id}`])}</td>
                <td className="num"><Money v={pm(k.amount)} /></td>
                {compareTo && <><td className="num muted"><Money v={ppm(c.id, k.id)} /></td><td className="num">{delta(pm(k.amount), ppm(c.id, k.id))}</td></>}
              </tr>,
            );
            return rows;
          })}
          {uncat !== 0 && <tr><td className="neg"><span className="caret" />Ukategoriseret</td><td className="num neg">{amountLink(uncat, 'det ukategoriserede', [`uncat:${kind}`])}</td><td className="num neg"><Money v={pm(uncat)} /></td>{compareTo && <><td /><td /></>}</tr>}
          <tr className="sum">
            <td>{title} i alt</td>
            <td className="num"><Money v={total} /></td>
            <td className="num"><Money v={pm(total)} /></td>
            {compareTo && <><td className="num muted"><Money v={perMonth(prevTotal, compareTo.cf.months)} /></td><td className="num">{delta(pm(total), perMonth(prevTotal, compareTo.cf.months))}</td></>}
          </tr>
        </tbody>
      </table>
      {sources && <SourcesDialog title={sources.title} refs={sources.refs} kind={kind} period={period} onClose={() => setSources(undefined)} />}
    </div>
  );
}

/** Højre side: som "Auditor"-feltet – passiv indkomst, totaler og månedligt cashflow. */
function Summary({ s, cf, cfPrev, prevName }: { s: Statement; cf: Cashflow; cfPrev?: Cashflow; prevName?: string }) {
  const cov = cf.passiveCoverage;
  const vs = (cur: number, before?: number, goodUp = true) =>
    before === undefined ? null : <div className={`small ${Math.abs(cur - before) < 50 ? 'muted' : (cur - before > 0) === goodUp ? 'pos' : 'neg'}`}>{signedKr(cur - before)} pr. md. vs. {prevName}</div>;
  return (
    <aside className="fs-card fs-summary">
      <div className="fs-bar">Opsummering</div>
      <div className="fs-sum-row">
        <div><b>Passiv indkomst</b><div className="small muted">renter, afkast, udbytte … – penge der arbejder for dig</div></div>
        <div className="num"><div className="fs-big"><Money v={cf.passiveM} /></div><div className="small muted">pr. måned</div>{vs(cf.passiveM, cfPrev?.passiveM)}</div>
      </div>
      <div className="fs-sum-row">
        <div><b>Passive udgifter</b><div className="small muted">{cf.passiveExpense ? 'faste udgifter, der løber af sig selv' : 'markér faste udgifter med "passiv" i udgiftslisten'}</div></div>
        <div className="num"><div className="fs-mid"><Money v={cf.passiveExpenseM} /></div><div className="small muted">pr. måned</div>{cf.passiveExpense ? vs(cf.passiveExpenseM, cfPrev?.passiveExpenseM, false) : null}</div>
      </div>
      {cov !== null && (
        <div className="fs-freedom" title="Når den passive indkomst dækker udgifterne (100 %), er du ude af 'rotteræset'">
          <div className="row small"><span className="ink2">Passiv indkomst dækker</span><span className="spacer" /><b>{pctf(Math.min(cov, 9.99))}</b><span className="ink2">af {cf.passiveExpense ? 'de passive udgifter' : 'udgifterne'}</span></div>
          <div className="bigprogress"><div style={{ width: `${Math.min(100, cov * 100)}%` }} /></div>
        </div>
      )}
      <div className="fs-sum-row">
        <b>Samlede indtægter</b>
        <div className="num"><div className="fs-mid"><Money v={cf.incomeM} /></div><div className="small muted">pr. måned</div>{vs(cf.incomeM, cfPrev?.incomeM)}</div>
      </div>
      <div className="fs-sum-row">
        <b>Samlede udgifter</b>
        <div className="num"><div className="fs-mid"><Money v={cf.expenseM} /></div><div className="small muted">pr. måned</div>{vs(cf.expenseM, cfPrev?.expenseM, false)}</div>
      </div>
      <div className={`fs-cashflow ${cf.cashflowM >= 0 ? 'up' : 'down'}`}>
        <div><b>Månedligt cashflow</b><div className="small ink2">indtægter − udgifter, gennemsnit pr. måned</div></div>
        <div className="num"><div className="fs-hero"><Money v={cf.cashflowM} signed /></div>{vs(cf.cashflowM, cfPrev?.cashflowM)}</div>
      </div>
      <p className="small muted">
        Gennemsnit over {fmtMonths(cf.months)} måneder ({cf.days} dage, {s.period.start} – {s.period.end}). Resultat for hele perioden: <b><Money v={s.result} /></b>.
      </p>
    </aside>
  );
}

/** Aktiver | Passiver side om side, grupperet efter type. */
function BalanceColumns({ s }: { s: Statement }) {
  const e = useEngine();
  const { accounts, accountTypes } = useData();
  const noteOf = (r: BsRow) => { const a = accounts.find((x) => `acc:${x.id}` === r.ref); return a && noteFor(a, s.period.id); };
  const groupOf = (r: BsRow) => {
    if (r.kind === 'cp') return r.side === 'asset' ? 'Tilgodehavender (udlæg)' : 'Gæld til personer (udlæg)';
    if (r.kind === 'transit') return 'Penge undervejs';
    const a = accounts.find((x) => `acc:${x.id}` === r.ref);
    return a ? typeName(accountTypes, a) : 'Andet';
  };
  return (
    <div className="fs-bal">
      {(['asset', 'liability'] as const).map((sd) => {
        const sign = sd === 'asset' ? 1 : -1;
        const rows = s.rows.filter((r) => r.side === sd && (r.open || r.close || r.kind === 'bank' || r.kind === 'valuation' || r.kind === 'tracked'));
        const groups = [...new Set(rows.map(groupOf))];
        const total = sd === 'asset' ? s.assetsClose : s.liabClose;
        const totalOpen = sd === 'asset' ? s.assetsOpen : s.liabOpen;
        return (
          <div key={sd} className="fs-section">
            <div className="fs-bar">{sd === 'asset' ? 'Aktiver' : 'Passiver'}</div>
            <table className="fs-table">
              <thead><tr><th>Post</th><th className="num">Ultimo</th><th className="num">Ændring</th></tr></thead>
              <tbody>
                {groups.flatMap((g) => [
                  <tr key={g} className="fs-group"><td colSpan={3}>{g}</td></tr>,
                  ...rows.filter((r) => groupOf(r) === g).map((r) => (
                    <tr key={r.ref} className="sub">
                      <td>{r.label}{noteOf(r) && <div className="small muted">{noteOf(r)}</div>}</td>
                      <td className="num"><Money precise v={r.close * sign} /></td>
                      <td className="num ink2"><Money precise v={(r.close - r.open) * sign} signed />{r.kind === 'valuation' && <ResultParts parts={valuationResultInPeriod(e.data, e.ledger, s.period, r.ref.slice(4))} categories={e.data.categories} />}</td>
                    </tr>
                  )),
                ])}
                {!rows.length && <tr><td colSpan={3} className="muted">Ingen</td></tr>}
                <tr className="sum"><td>{sd === 'asset' ? 'Aktiver' : 'Passiver'} i alt</td><td className="num"><Money precise v={total} /></td><td className="num"><Money precise v={total - totalOpen} signed /></td></tr>
              </tbody>
            </table>
          </div>
        );
      })}
      <div className="fs-equity">
        <span>Egenkapital (nettoformue) = aktiver − passiver</span>
        <span className="spacer" />
        <span className="fs-mid num"><Money precise v={s.equityClose} /></span>
        <span className={`small ${s.equityClose - s.equityOpen >= 0 ? 'pos' : 'neg'}`}>{signedKr(s.equityClose - s.equityOpen)} i perioden</span>
      </div>
    </div>
  );
}
