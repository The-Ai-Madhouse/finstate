import { NoPeriod } from '../components/PeriodPrompt';
import { demoData } from '../../domain/demo';
import { comparePeriod, periodChecks } from '../../domain/engine';
import { dateDa, kr, pctf, signedKr } from '../../domain/format';
import { keyFigures } from '../../domain/insights';
import { useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { TrendLine } from '../components/charts';
import { CheckList, Tile } from '../components/common';
import { GuideCard, useGuide } from '../components/Guide';

export function OverviewView() {
  const e = useEngine();
  const period = usePeriod();
  const guide = useGuide();
  const replaceAll = useStore((s) => s.replaceAll);
  const setPeriod = useStore((s) => s.setPeriod);
  const { data } = e;

  if (!period) {
    const firstTime = !data.txs.length && !data.periods.length;
    return (
      <div className="stack" style={{ maxWidth: 860 }}>
        <h1>{firstTime ? 'Velkommen til Finstate' : 'Overblik'}</h1>
        {firstTime && (
          <p className="ink2">
            Dit halvårlige/årlige financial statement – bygget på dobbelt bogholderi og kørende 100 % i din browser. Ingen server, intet login, ingen data ud af maskinen.
            Du starter med at vælge perioden, og så tager guiden dig igennem resten.
          </p>
        )}
        {!data.categories.length && <GuideCard />}
        <NoPeriod />
        {firstTime && (
          <div className="row">
            <span className="muted small">Vil du bare se, hvordan det ser ud?</span>
            <button className="btn" onClick={() => { replaceAll(demoData()); setPeriod('p-2026-h1'); }}>Prøv med fiktive demodata</button>
          </div>
        )}
      </div>
    );
  }

  const s = e.statement(period);
  const prevP = comparePeriod(data, period);
  const prev = prevP ? e.statement(prevP) : undefined;
  const k = keyFigures(s);
  const kp = prev ? keyFigures(prev) : undefined;
  const checks = periodChecks(e, period);
  const hasData = data.txs.some((t) => t.date >= period.start && t.date <= period.end);
  const allDone = guide.filter((g) => g.group !== 'result').every((g) => g.status === 'done');
  const errors = checks.filter((c) => c.level === 'error' || c.level === 'warn').length;
  const trend = [...data.periods]
    .filter((p) => p.end <= period.end && p.end > data.settings.bookStart)
    .sort((a, b) => (a.end < b.end ? -1 : 1))
    // Brug kun ikke-overlappende perioder (fx H1/H2 – ikke også helår).
    .filter((p, i, arr) => !arr.some((o, j) => j !== i && o.end === p.end && o.start > p.start))
    .map((p) => ({ label: p.name, value: e.statement(p).equityClose }));

  return (
    <div className="stack">
      <div className="row">
        <h1>Financial statement {period.name}</h1>
        <span className="muted">{dateDa(period.start)} – {dateDa(period.end)}{prevP ? ` · sammenlignes med ${prevP.name}` : ''}</span>
      </div>
      {!allDone && <GuideCard />}
      {!hasData ? (
        <p className="small muted">Nøgletal, status og udvikling vises her, når du har importeret bankdata for {period.name}.</p>
      ) : (<>
      <div className="tiles">
        <Tile label="Nettoformue (egenkapital)" value={kr(k.netWorth)} delta={`${signedKr(k.netWorthDelta)} i perioden`} deltaGood={k.netWorthDelta >= 0} />
        <Tile label="Indtægter" value={kr(k.income)} delta={kp ? `${signedKr(k.income - kp.income)} vs. ${prevP!.name}` : undefined} deltaGood={kp ? k.income >= kp.income : undefined} />
        <Tile label="Udgifter" value={kr(k.expense)} delta={kp ? `${signedKr(k.expense - kp.expense)} vs. ${prevP!.name}` : undefined} deltaGood={kp ? k.expense <= kp.expense : undefined} />
        <Tile label="Opsparingsrate" value={k.savingsRate === null ? '–' : pctf(k.savingsRate)} delta={kp?.savingsRate != null && k.savingsRate !== null ? `${kp.savingsRate <= k.savingsRate ? '+' : '−'}${pctf(Math.abs(k.savingsRate - kp.savingsRate))}-point` : undefined} deltaGood={kp?.savingsRate != null && k.savingsRate !== null ? k.savingsRate >= kp.savingsRate : undefined} />
      </div>
      <div className="grid2">
        <div className="card">
          <div className="card-head">
            <h2>Status for perioden</h2>
            <span className="spacer" />
            <span className={`chip ${errors ? 'review' : 'user'}`}>{errors ? `${errors} punkter at se på` : 'Klar til slideshow'}</span>
          </div>
          <CheckList checks={checks} />
        </div>
        <div className="card">
          <h2>Nettoformue over tid</h2>
          <TrendLine points={trend} />
        </div>
      </div>
      </>)}
    </div>
  );
}
