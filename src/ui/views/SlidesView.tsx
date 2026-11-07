import { NoPeriod } from '../components/PeriodPrompt';
import { useEffect, useState, type ReactNode } from 'react';
import { comparePeriod } from '../../domain/engine';
import { dateDa, kr, pctf, signedKr } from '../../domain/format';
import { catDeltas, keyFigures, narrative } from '../../domain/insights';
import type { Period } from '../../domain/types';
import { useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { BarCompare, TrendLine } from '../components/charts';
import { Money } from '../components/common';
import { rowsFor } from './StatementView';

interface SlideDef { key: string; title: string; render: (text: string) => ReactNode; defaultText: string; hint: string }

export function SlidesView() {
  const period = usePeriod();
  if (!period) return <NoPeriod />;
  return <Deck period={period} />;
}

function Deck({ period }: { period: Period }) {
  const e = useEngine();
  const update = useStore((s) => s.update);
  const [presenting, setPresenting] = useState<number | null>(null);
  const { data } = e;
  const s = e.statement(period);
  const prevP = comparePeriod(data, period);
  const prev = prevP ? e.statement(prevP) : undefined;
  const k = keyFigures(s);
  const kp = prev ? keyFigures(prev) : undefined;
  const n = narrative(s, prev);
  const notes = data.slideNotes[period.id] ?? {};
  const text = (key: string, def: string) => notes[key] ?? def;
  const setText = (key: string, v: string | undefined) =>
    update((d) => {
      const cur = { ...(d.slideNotes[period.id] ?? {}) };
      if (v === undefined) delete cur[key];
      else cur[key] = v;
      return { ...d, slideNotes: { ...d.slideNotes, [period.id]: cur } };
    });

  const trend = [...data.periods]
    .filter((p) => p.end <= period.end && p.end > data.settings.bookStart && Math.abs(Date.parse(p.end) - Date.parse(p.start) - (Date.parse(period.end) - Date.parse(period.start))) < 10 * 86400000)
    .sort((a, b) => (a.end < b.end ? -1 : 1))
    .map((p) => ({ label: p.name, value: e.statement(p).equityClose }));
  const deltas = [...catDeltas(s.expense, prev?.expense).map((d) => ({ ...d, kind: 'Udgift' })), ...catDeltas(s.income, prev?.income).map((d) => ({ ...d, kind: 'Indtægt' }))]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 7);
  const bullets = (t: string) => <ul>{t.split('\n').filter((l) => l.trim()).map((l, i) => <li key={i}>{l.replace(/^[-•*]\s*/, '')}</li>)}</ul>;
  const vs = (cur: number, p?: number, goodUp = true) =>
    p === undefined ? undefined : <span className={cur - p === 0 ? '' : (cur - p > 0) === goodUp ? 'pos' : 'neg'}>{signedKr(cur - p)} vs. {prevP!.name}</span>;

  const slides: SlideDef[] = [
    {
      key: 'title', title: 'Forside', hint: 'Undertitel',
      defaultText: `${dateDa(period.start)} – ${dateDa(period.end)}`,
      render: (t) => (
        <div className="col" style={{ justifyContent: 'center', height: '100%', gap: '3cqw' }}>
          <div className="kicker">Financial statement</div>
          <div style={{ fontSize: '6cqw', fontWeight: 750, lineHeight: 1 }}>{period.name}</div>
          <div className="comment">{t}</div>
          <div style={{ marginTop: '4cqw' }}>
            <div className="comment">Nettoformue</div>
            <div className="big">{kr(k.netWorth)}</div>
            <div className="comment"><span className={k.netWorthDelta >= 0 ? 'pos' : 'neg'}>{signedKr(k.netWorthDelta)}</span> i perioden</div>
          </div>
        </div>
      ),
    },
    {
      key: 'summary', title: 'Nøgletal', hint: 'Kort opsummering', defaultText: n.summary,
      render: (t) => (
        <>
          <div className="tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="tile"><div className="lbl">Indtægter</div><div className="val">{kr(k.income)}</div><div className="delta">{vs(k.income, kp?.income)}</div></div>
            <div className="tile"><div className="lbl">Udgifter</div><div className="val">{kr(k.expense)}</div><div className="delta">{vs(k.expense, kp?.expense, false)}</div></div>
            <div className="tile"><div className="lbl">Resultat</div><div className="val">{kr(k.result)}</div><div className="delta">{vs(k.result, kp?.result)}</div></div>
            <div className="tile"><div className="lbl">Opsparingsrate</div><div className="val">{k.savingsRate === null ? '–' : pctf(k.savingsRate)}</div><div className="delta">{kp?.savingsRate != null && k.savingsRate !== null ? `${prevP!.name}: ${pctf(kp.savingsRate)}` : ''}</div></div>
          </div>
          <div className="comment">{t}</div>
        </>
      ),
    },
    {
      key: 'networth', title: 'Nettoformue over tid', hint: 'Kommentar', defaultText: n.progress[0] ?? n.setbacks[0] ?? '',
      render: (t) => <><div style={{ flex: 1, minHeight: 0 }}><TrendLine points={trend} height={260} /></div><div className="comment">{t}</div></>,
    },
    {
      key: 'balance', title: 'Balance', hint: 'Kommentar', defaultText: n.balanceComment,
      render: (t) => (
        <div className="body">
          {(['asset', 'liability'] as const).map((sd) => (
            <table key={sd} style={{ fontSize: '1.5cqw', alignSelf: 'flex-start' }}>
              <thead><tr><th>{sd === 'asset' ? 'Aktiver' : 'Gæld'}</th><th className="num">Primo</th><th className="num">Ultimo</th></tr></thead>
              <tbody>
                {s.rows.filter((r) => r.side === sd).map((r) => (
                  <tr key={r.ref}><td>{r.label}</td><td className="num muted"><Money v={Math.abs(r.open)} /></td><td className="num"><Money v={Math.abs(r.close)} /></td></tr>
                ))}
                <tr className="sum"><td>I alt</td><td className="num"><Money v={sd === 'asset' ? s.assetsOpen : s.liabOpen} /></td><td className="num"><Money v={sd === 'asset' ? s.assetsClose : s.liabClose} /></td></tr>
                {sd === 'liability' && <tr className="sum"><td>Egenkapital</td><td className="num"><Money v={s.equityOpen} /></td><td className="num"><Money v={s.equityClose} /></td></tr>}
              </tbody>
            </table>
          ))}
          <div className="comment" style={{ position: 'absolute', bottom: '6%', left: '5.5%', right: '5.5%' }}>{t}</div>
        </div>
      ),
    },
    {
      key: 'income', title: 'Indtægter', hint: 'Kommentar', defaultText: n.incomeComment,
      render: (t) => <><div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}><BarCompare rows={rowsFor(s.income, prev?.income).slice(0, 8)} nowLabel={period.name} prevLabel={prevP?.name} rowH={28} /></div><div className="comment">{t}</div></>,
    },
    {
      key: 'expense', title: 'Udgifter', hint: 'Kommentar', defaultText: n.expenseComment,
      render: (t) => <><div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}><BarCompare rows={rowsFor(s.expense, prev?.expense).slice(0, 8)} nowLabel={period.name} prevLabel={prevP?.name} rowH={28} /></div><div className="comment">{t}</div></>,
    },
    ...(prev ? [{
      key: 'changes', title: `Største ændringer siden ${prevP!.name}`, hint: 'Kommentar', defaultText: '',
      render: (t: string) => (
        <>
          <table style={{ fontSize: '1.6cqw' }}>
            <thead><tr><th>Kategori</th><th className="num">{prevP!.name}</th><th className="num">{period.name}</th><th className="num">Ændring</th></tr></thead>
            <tbody>
              {deltas.map((d) => {
                const good = d.kind === 'Indtægt' ? d.delta > 0 : d.delta < 0;
                return <tr key={d.kind + d.id}><td>{d.name} <span className="muted">· {d.kind.toLowerCase()}</span></td><td className="num muted"><Money v={d.prev} /></td><td className="num"><Money v={d.now} /></td><td className={`num ${good ? 'pos' : 'neg'}`}>{signedKr(d.delta)}{d.rel !== null ? ` (${pctf(d.rel)})` : ''}</td></tr>;
              })}
            </tbody>
          </table>
          {t && <div className="comment">{t}</div>}
        </>
      ),
    }] : []),
    {
      key: 'progress', title: 'Fremgang', hint: 'Én pointe pr. linje', defaultText: n.progress.join('\n'),
      render: (t) => <div className="body"><div className="grow">{bullets(t)}</div></div>,
    },
    {
      key: 'setbacks', title: 'Modgang', hint: 'Én pointe pr. linje', defaultText: n.setbacks.join('\n'),
      render: (t) => <div className="body"><div className="grow">{bullets(t)}</div></div>,
    },
    {
      key: 'verdict', title: 'Hvordan gik det?', hint: 'Din samlede vurdering',
      defaultText: `${n.summary}\n\n[Skriv din vurdering: Hvad lykkedes? Hvad vil du gøre anderledes næste halvår? Mål for ${period.name.replace(/\d{4}/, (y) => String(Number(y) + 1))}?]`,
      render: (t) => <div className="comment" style={{ fontSize: '2.2cqw', color: 'var(--ink)' }}>{t}</div>,
    },
  ];

  useEffect(() => {
    if (presenting === null) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setPresenting(null);
      if (['ArrowRight', ' ', 'PageDown'].includes(ev.key)) setPresenting((i) => Math.min(slides.length - 1, (i ?? 0) + 1));
      if (['ArrowLeft', 'PageUp'].includes(ev.key)) setPresenting((i) => Math.max(0, (i ?? 0) - 1));
    };
    window.addEventListener('keydown', onKey);
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [presenting === null, slides.length]);

  const renderSlide = (sl: SlideDef, i: number) => (
    <div className="slide">
      {sl.key !== 'title' && <><div className="kicker">{period.name}</div><h2>{sl.title}</h2></>}
      {sl.render(text(sl.key, sl.defaultText))}
      <div className="pageno">{i + 1} / {slides.length}</div>
    </div>
  );

  if (presenting !== null) {
    return (
      <div className="present" onClick={() => setPresenting(Math.min(slides.length - 1, presenting + 1))}>
        {renderSlide(slides[presenting], presenting)}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row no-print">
        <h1>Slideshow {period.name}</h1>
        <span className="muted small">{prevP ? `Sammenlignet med ${prevP.name}` : 'Ingen sammenligningsperiode'}</span>
        <span className="spacer" />
        <button className="btn" onClick={() => window.print()}>Gem som PDF</button>
        <button className="btn primary" onClick={() => setPresenting(0)}>▶ Præsentér</button>
      </div>
      <p className="ink2 small no-print">Teksterne er forslag ud fra tallene. Ret dem direkte – dine rettelser gemmes for perioden, mens tal og diagrammer altid følger regnskabet.</p>
      <div className="deck">
        {slides.map((sl, i) => {
          const custom = notes[sl.key] !== undefined;
          return (
            <div key={sl.key} className="col" style={{ gap: 8 }}>
              {renderSlide(sl, i)}
              <div className="row no-print" style={{ alignItems: 'flex-start' }}>
                <textarea
                  rows={sl.key === 'verdict' || sl.key === 'progress' || sl.key === 'setbacks' ? 5 : 2}
                  className="grow"
                  aria-label={`${sl.title}: ${sl.hint}`}
                  placeholder={sl.hint}
                  value={text(sl.key, sl.defaultText)}
                  onChange={(ev) => setText(sl.key, ev.target.value)}
                />
                <div className="col" style={{ gap: 4 }}>
                  <span className={`chip ${custom ? 'user' : ''}`}>{custom ? 'Din tekst' : 'Forslag'}</span>
                  {custom && <button className="btn sm ghost" title="Gendan det automatiske forslag" onClick={() => setText(sl.key, undefined)}>Gendan</button>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
