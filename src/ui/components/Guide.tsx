import type { ReactNode } from 'react';
import { NEEDS_REVIEW } from '../../domain/classify';
import { importCoverage, inPeriod, periodChecks, type Engine } from '../../domain/engine';
import { defaultCategories } from '../../domain/defaults';
import type { Period } from '../../domain/types';
import { useEngine, usePeriod } from '../../store/actions';
import { useStore, type View } from '../../store/store';
import type { NavTarget } from '../../domain/nav-target';

type Status = 'done' | 'todo' | 'waiting';

export interface GuideStep {
  id: string;
  n: number;
  /** setup = én gang (gælder alle perioder); statement = trin for det aktuelle financial statement; result = output. */
  group: 'setup' | 'statement' | 'result';
  view: View;
  /** Fane i Indstillinger, hvis trinnet hører til en bestemt fane. */
  tab?: string;
  /** "Gå til" fører hen til det første, der mangler i trinnet – og fremhæver det. */
  target?: NavTarget;
  title: string;
  help: ReactNode;
  status: Status;
  detail?: string;
  action?: { label: string; run: () => void };
}

export function useGuide(): GuideStep[] {
  const e = useEngine();
  const period = usePeriod();
  const update = useStore((s) => s.update);
  return buildSteps(e, period, update);
}

function buildSteps(e: Engine, period: Period | undefined, update: ReturnType<typeof useStore.getState>['update']): GuideStep[] {
  const { data } = e;
  const checks = period ? periodChecks(e, period) : [];
  const bad = (view: string) => checks.filter((c) => c.view === view && (c.level === 'warn' || c.level === 'error'));
  const txInPeriod = period ? data.txs.filter((t) => inPeriod(t, period) && t.date > data.settings.bookStart) : [];
  const review = txInPeriod.filter((t) => NEEDS_REVIEW.has(e.resolved.get(t.id)!.source)).length;
  const coverage = period ? importCoverage(data, period) : [];
  const uncovered = coverage.filter((c) => (!c.coversStart || !c.coversEnd) && !c.accepted);
  const valuations = data.accounts.filter((a) => a.kind === 'valuation' && (period?.accountIds ? period.accountIds.includes(a.id) : !a.archived));
  const missingVal = period ? valuations.filter((a) => !data.valuations.some((v) => v.accountId === a.id && v.date === period.end)) : valuations;
  const setPeriodFlag = (patch: Partial<Period>) =>
    period && update((d) => ({ ...d, periods: d.periods.map((p) => (p.id === period.id ? { ...p, ...patch } : p)) }));

  const steps: Omit<GuideStep, 'n'>[] = [
    {
      id: 'categories',
      group: 'setup',
      view: 'settings',
      tab: 'categories',
      title: 'Lav dit kategoritræ',
      help: (
        <>
          Kategoritræet er <b>dit eget</b> og gælder for alle dine financial statements – fx Bolig › Husleje eller Transport › Brændstof. Indsæt et eksempeltræ
          med ét klik og ret det til, eller byg dit eget. Du kan også oprette kategorier undervejs med "+ Ny kategori…" nederst i ethvert kategorivalg.
        </>
      ),
      status: data.categories.length ? 'done' : 'todo',
      action: data.categories.length ? undefined : { label: 'Indsæt eksempeltræ', run: () => update((d) => ({ ...d, categories: defaultCategories() })) },
    },
    {
      id: 'import',
      group: 'statement',
      view: 'import',
      title: 'Importér bankdata for perioden',
      help: (
        <>
          Hent transaktionerne som CSV i netbanken – én fil pr. konto, der dækker hele perioden (gerne lidt før og efter) – og træk dem ind. Finstate genkender selv kolonnerne,
          og overlappende filer er ufarlige. Har du flere konti, så importér dem alle, så overførsler mellem dem kan parres.
        </>
      ),
      status: !period ? 'waiting' : coverage.length && !uncovered.length ? 'done' : 'todo',
      detail: !period ? undefined : !coverage.length
        ? 'Ingen bankkonti endnu – de oprettes, når du importerer din første fil.'
        : uncovered.length ? `Mangler data: ${uncovered.map((c) => `${c.name} (${!c.first ? 'ingen data' : !c.coversStart ? `fra ${c.first}` : `til ${c.last}`})`).join(', ')}` : undefined,
    },
    {
      id: 'ledger',
      group: 'statement',
      view: 'ledger',
      title: 'Kategorisér',
      help: (
        <>
          Giv hver transaktion i perioden en <b>type</b> og en kategori fra dit kategoritræ (bankens kategori bruges højst som første gæt). Med <b>Lignende</b> giver du alle transaktioner med samme tekst samme kategori på én gang.
          <br /><b>Indtægt/Udgift</b> = rigtige penge ind eller ud (følger fortegnet). <b>Intern</b> = penge der flytter til/fra en post på din balance – en anden konto, et depot, et lån eller fx "Jonas skylder mig", når du lægger ud for nogen.
        </>
      ),
      status: !txInPeriod.length ? 'waiting' : review ? 'todo' : 'done',
      detail: !period ? undefined : !txInPeriod.length ? 'Ingen transaktioner i perioden endnu – importér først.' : review ? `${review} transaktioner mangler din afgørelse` : undefined,
    },
    {
      id: 'transfers',
      group: 'statement',
      view: 'transfers',
      title: 'Tjek overførsler',
      help: (
        <>
          Overførsler mellem dine konti skal findes på begge konti. Hvis modposten først kommer i næste periode, står beløbet automatisk som <b>penge undervejs</b>.
          Poster som "Jonas skylder mig" følger dine overførsler og står på balancen, indtil de er udlignet.
        </>
      ),
      status: !txInPeriod.length ? 'waiting' : bad('transfers').length ? 'todo' : 'done',
    },
    {
      id: 'balance',
      group: 'statement',
      view: 'balance',
      title: 'Gør balancen komplet',
      help: (
        <>
          Din balance er alt, du ejer (<b>aktiver</b>) og skylder (<b>passiver</b>). Bankkonti følger dine filer. Tilføj resten med "+ Tilføj aktiv/passiv" – fx investeringer,
          kontanter, et billån, gæld til personer eller skat til betaling – og skriv værdierne pr. periodens start og slut. Bekræft til sidst, at intet mangler.
        </>
      ),
      status: !period ? 'waiting' : missingVal.length || !period.balanceConfirmed ? 'todo' : 'done',
      detail: missingVal.length && period ? `Mangler værdi pr. ${period.end}: ${missingVal.map((a) => a.name).join(', ')} (har du ikke posten mere, så fjern den fra perioden under Detaljer)` : undefined,
      action: period && data.accounts.length && !missingVal.length && !period.balanceConfirmed ? { label: 'Balancen er komplet ✓', run: () => setPeriodFlag({ balanceConfirmed: true }) } : undefined,
    },
    {
      id: 'slides',
      group: 'result',
      view: 'slides',
      title: 'Se regnskabet og lav slideshowet',
      help: <>Regnskabet sammenlignes med forrige periode, og slideshowet bygges ud fra tallene. Ret forslagsteksterne – især "Hvordan gik det?" – og præsentér eller gem som PDF.</>,
      status: 'waiting',
    },
  ];
  // Mål for "Gå til": den vigtigste kontrol, der ikke er OK på trinnets side – ellers det oplagte sted at starte.
  const RANK = { error: 0, warn: 1, info: 2, ok: 3 } as const;
  const firstOpen = (view: View, ids?: RegExp) => checks
    .filter((c) => c.level !== 'ok' && c.target?.view === view && (!ids || ids.test(c.id)))
    .sort((a, b) => RANK[a.level] - RANK[b.level])[0]?.target;
  const defaults: Record<string, NavTarget | undefined> = {
    categories: data.categories.length ? undefined : { view: 'settings', tab: 'categories', key: 'settings:categories:seed' },
    import: firstOpen('import') ?? (uncovered[0] ? { view: 'import', key: `import:cover:${uncovered[0].accountId}`, reason: `Mangler data: ${uncovered[0].name}` } : coverage.length ? undefined : { view: 'import', key: 'import:drop' }),
    ledger: review ? firstOpen('ledger', /^review$/) : firstOpen('ledger'),
    transfers: firstOpen('transfers'),
    balance: firstOpen('balance', /^(val|bal|w|uncat-post)-/) ?? (period && !missingVal.length && !period.balanceConfirmed && data.accounts.length ? { view: 'balance', key: 'balance:confirm' } : undefined),
  };
  for (const st of steps) if (st.status !== 'done' && defaults[st.id]) st.target = defaults[st.id];
  let n = 0;
  const numbered = steps.map((s) => ({ ...s, n: s.group === 'statement' ? ++n : 0 }));
  const result = numbered.find((s) => s.group === 'result')!;
  result.status = numbered.filter((s) => s.group === 'statement').every((s) => s.status === 'done') ? 'done' : 'waiting';
  return numbered;
}

/** Det ene trin, brugeren skal tage nu: først opsætning, så periodens trin i rækkefølge. */
export function nextStepOf(steps: GuideStep[]): GuideStep | undefined {
  return steps.filter((s) => s.group !== 'result').find((s) => s.status !== 'done');
}

/** Farven viser vejen, ikke status: færdig = grøn ✓, næste = blå, resten = neutral. */
function icoClass(s: GuideStep, next?: GuideStep) {
  return s.status === 'done' ? 'ok' : s === next ? 'current' : 'upcoming';
}

/** Hele guiden – vises på Overblik. Opsætning (én gang) står for sig; trinene hører til det aktuelle financial statement. */
export function GuideCard() {
  const steps = useGuide();
  const period = usePeriod();
  const setView = useStore((s) => s.setView);
  const goTo = useStore((s) => s.goTo);
  const open = (s: GuideStep) => (s.target ? goTo(s.target) : setView(s.view, s.tab));
  const work = steps.filter((s) => s.group === 'statement');
  const setup = steps.filter((s) => s.group === 'setup' && s.status !== 'done');
  const result = steps.find((s) => s.group === 'result')!;
  const done = work.filter((s) => s.status === 'done').length;
  const next = nextStepOf(steps);
  const nothingDone = !work.some((s) => s.status === 'done');
  const row = (s: GuideStep) => {
    const isNext = s === next;
    const cls = icoClass(s, next);
    return (
      <div key={s.id} className={`check guide-step ${cls}`}>
        <span className={`ico ${cls}`}>{s.status === 'done' ? '✓' : s.group === 'statement' ? s.n : '★'}</span>
        <div className="grow">
          <div><b>{s.title}</b>{s.group === 'setup' && <span className="small muted"> · opsætning, én gang</span>}</div>
          {isNext && <div className="small ink2" style={{ marginTop: 2 }}>{s.help}</div>}
          {isNext && s.detail && <div className="small muted" style={{ marginTop: 2 }}>{s.detail}</div>}
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          {isNext && s.action && <button className="btn sm primary" onClick={s.action.run}>{s.action.label}</button>}
          {isNext
            ? <button className={`btn sm ${s.action ? '' : 'primary'}`} onClick={() => open(s)}>{nothingDone && s.group === 'statement' ? 'Start her →' : 'Gå til →'}</button>
            : <button className="btn sm ghost" onClick={() => open(s)}>{s.status === 'done' ? 'Åbn' : 'Gå til'}</button>}
        </div>
      </div>
    );
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>{period ? `Financial statement ${period.name} · ${done} af ${work.length} trin` : 'Kom i gang'}</h2>
        {period && <div className="progress" aria-hidden><div style={{ width: `${(done / work.length) * 100}%` }} /></div>}
      </div>
      {setup.map(row)}
      {period && work.map(row)}
      {period && (
        <div className={`check guide-step ${result.status === 'done' ? 'current' : 'upcoming'}`}>
          <span className={`ico ${result.status === 'done' ? 'current' : 'upcoming'}`}>▶</span>
          <div className="grow">
            <div><b>Resultat: regnskab og slideshow</b></div>
            <div className="small muted">{result.status === 'done' ? 'Alt er klar – se regnskabet og præsentér.' : 'Bliver klar, når trinene ovenfor er færdige. Du kan kigge undervejs.'}</div>
          </div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <button className={`btn sm ${result.status === 'done' ? '' : 'ghost'}`} onClick={() => setView('statement')}>Regnskab</button>
            <button className={`btn sm ${result.status === 'done' ? 'primary' : 'ghost'}`} onClick={() => setView('slides')}>Slideshow</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Kort forklaring øverst på hver side, så man ved hvad man skal gøre her. */
export function ViewHelp({ view }: { view: View }) {
  const steps = useGuide();
  const period = usePeriod();
  // Vælg det rå felt (stabil reference) – `?? []` i selectoren giver et nyt array ved hver render → uendelig løkke.
  const hiddenRaw = useStore((s) => s.data.settings.hiddenHelp);
  const hidden = hiddenRaw ?? [];
  const update = useStore((s) => s.update);
  const setView = useStore((s) => s.setView);
  const forView = steps.filter((s) => s.view === view);
  const step = forView.find((s) => s.status !== 'done') ?? forView[forView.length - 1];
  if (!step) return null;
  const work = steps.filter((s) => s.group === 'statement');
  const nextStep = step.group === 'statement' ? work.find((s) => s.n > step.n) ?? steps.find((s) => s.group === 'result') : undefined;
  if (hidden.includes(view)) {
    return (
      <div className="row">
        {/* Trinnets handling (fx "Balancen er komplet ✓") skal kunne nås – også når hjælpen er skjult. */}
        {step.action && <button className="btn sm primary" data-focus={step.id === 'balance' ? 'balance:confirm' : undefined} onClick={step.action.run}>{step.action.label}</button>}
        <button className="btn sm ghost help-toggle" onClick={() => update((d) => ({ ...d, settings: { ...d.settings, hiddenHelp: (d.settings.hiddenHelp ?? []).filter((v) => v !== view) } }))}>
          ? Hvad skal jeg gøre her
        </button>
      </div>
    );
  }
  const heading = step.group === 'setup' ? `Opsætning (én gang): ${step.title}`
    : step.group === 'result' ? step.title
    : `${period ? `${period.name} · ` : ''}Trin ${step.n} af ${work.length}: ${step.title}`;
  return (
    <div className="help">
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <span className={`ico ${icoClass(step, nextStepOf(steps))}`} style={{ marginTop: 1 }}>{step.status === 'done' ? '✓' : step.group === 'statement' ? step.n : step.group === 'setup' ? '★' : '▶'}</span>
        <div className="grow">
          <div><b>{heading}</b></div>
          <div className="small ink2" style={{ marginTop: 2 }}>{step.help}</div>
          {step.detail && <div className="small" style={{ marginTop: 4 }}>{step.detail}</div>}
        </div>
        <div className="col" style={{ alignItems: 'flex-end' }}>
          {step.action && <button className="btn sm primary" data-focus={step.id === 'balance' ? 'balance:confirm' : undefined} onClick={step.action.run}>{step.action.label}</button>}
          {step.status === 'done' && nextStep && <button className="btn sm primary" onClick={() => (nextStep.target ? useStore.getState().goTo(nextStep.target) : setView(nextStep.view, nextStep.tab))}>Næste: {nextStep.group === 'result' ? 'Resultat' : nextStep.title} →</button>}
          <button className="btn sm ghost" onClick={() => update((d) => ({ ...d, settings: { ...d.settings, hiddenHelp: [...(d.settings.hiddenHelp ?? []), view] } }))}>Skjul</button>
        </div>
      </div>
    </div>
  );
}
