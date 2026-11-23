import { UndoLayer } from './components/Undo';
import { StatementSwitcher } from './components/PeriodPrompt';
import { NEEDS_REVIEW } from '../domain/classify';
import { inPeriod } from '../domain/engine';
import { useEngine, usePeriod } from '../store/actions';
import { useStore, type View } from '../store/store';
import { VERSION_DETAILS, VERSION_LABEL } from '../version';
import { ViewHelp, nextStepOf, useGuide } from './components/Guide';
import { BalanceView } from './views/BalanceView';
import { ImportView } from './views/ImportView';
import { LedgerView } from './views/LedgerView';
import { OverviewView } from './views/OverviewView';
import { SettingsView } from './views/SettingsView';
import { SlidesView } from './views/SlidesView';
import { StatementView } from './views/StatementView';
import { TransfersView } from './views/TransfersView';
import { VersionsView } from './views/VersionsView';
import { BudgetView } from './views/BudgetView';
import { PairDialog } from './components/PairDialog';
import { NavCallout, useNavFocus } from './components/NavFocus';

/** Arbejdstrin: her skal brugeren gøre noget → nummer, der bliver til ✓. */
const WORK: { id: View; label: string; n: number; steps: string[] }[] = [
  { id: 'import', label: 'Importér', n: 1, steps: ['import'] },
  { id: 'ledger', label: 'Kategorisér', n: 2, steps: ['ledger'] },
  { id: 'transfers', label: 'Overførsler', n: 3, steps: ['transfers'] },
  { id: 'balance', label: 'Aktiver & passiver', n: 4, steps: ['balance'] },
];
/** Resultater: bygges af trinnene → ingen flueben, men "klar". */
const RESULTS: { id: View; label: string; icon: string }[] = [
  { id: 'statement', label: 'Regnskab', icon: '≡' },
  { id: 'slides', label: 'Slideshow', icon: '▶' },
];

export function App() {
  const saveMode = useStore((s) => s.saveStatus.mode);
  const localMode = useStore((s) => s.saveStatus.local);
  const clientMode = useStore((s) => s.saveStatus.client);
  const view = useStore((s) => s.view);
  const engine = useEngine();
  const period = usePeriod();
  const guide = useGuide();
  const nextStep = nextStepOf(guide);
  const workDone = WORK.map((w) => {
    const steps = guide.filter((g) => w.steps.includes(g.id));
    return { label: w.label, done: steps.length > 0 && steps.every((g) => g.status === 'done') };
  });
  const missing = workDone.filter((w) => !w.done).map((w) => w.label);
  const ready = !!period && missing.length === 0;
  const reviewCount = period
    ? engine.data.txs.filter((t) => inPeriod(t, period) && t.date > engine.data.settings.bookStart && NEEDS_REVIEW.has(engine.resolved.get(t.id)!.source)).length
    : 0;
  // "Gå til …": rul hen til målet og markér det tydeligt.
  useNavFocus();
  return (
    <div className="app">
      <PairDialog />
      <NavCallout />
      <UndoLayer />
      <nav className="nav" aria-label="Hovedmenu">
        <div className="brand"><span className="brand-mark" aria-hidden>◐</span>Finstate <small>lokalt & privat</small></div>
        <StatementSwitcher />
        <NavItem id="overview" label="Overblik" icon={<span className="step">⌂</span>} />

        <div className="nav-label">Dagligt budget</div>
        <NavItem id="budget" label="Abonnementer" icon={<span className="step bud-ic">◷</span>} />

        <div className="nav-label">Arbejdsgang</div>
        {WORK.map((w) => {
          const steps = guide.filter((g) => w.steps.includes(g.id));
          const done = steps.length > 0 && steps.every((g) => g.status === 'done');
          return (
            <NavItem key={w.id} id={w.id} label={w.label} disabled={!period}
              icon={<span className={`step ${done ? 'done' : period && nextStep?.view === w.id ? 'current' : ''}`} title={done ? 'Færdig' : nextStep?.view === w.id ? 'Næste trin' : undefined}>{done ? '✓' : w.n}</span>}
              extra={w.id === 'ledger' && reviewCount > 0 ? <span className="badge">{reviewCount}</span> : undefined} />
          );
        })}

        <div className="nav-label">Resultat</div>
        {RESULTS.map((r) => (
          <NavItem key={r.id} id={r.id} label={r.label} disabled={!period}
            icon={<span className="step result">{r.icon}</span>}
            extra={ready ? <span className="ready" title="Alle arbejdstrin er færdige">klar</span> : undefined}
            title={ready ? undefined : `Kan ses undervejs – bliver endelig, når ${missing.join(', ')} er færdig${missing.length > 1 ? 'e' : ''}`} />
        ))}

        <div className="nav-tools">
          <NavItem id="settings" label="Indstillinger" icon={<span className="step">⚙</span>} />
        </div>
        <div className="nav-foot">
          Data forlader aldrig din computer. {saveMode === 'error' ? 'Kunne ikke gemme – kører serveren?' : clientMode === 'folder' ? 'Gemt krypteret i en mappe på denne computer.' : clientMode === 'browser' ? 'Gemt i browseren på denne computer.' : localMode ? 'Krypteret og kører kun på din computer.' : 'Krypteret og kræver login med 2FA.'}
          <div className="nav-version" title={VERSION_DETAILS}>{VERSION_LABEL}</div>
        </div>
      </nav>
      <div className="main">
        <TopBar />
        <div className="content" data-view={view} key={view}>
          {view !== 'overview' && view !== 'budget' && <div className="no-print" style={{ marginBottom: 16 }}><ViewHelp view={view} /></div>}
          {view === 'overview' && <OverviewView />}
          {view === 'import' && <ImportView />}
          {view === 'ledger' && <LedgerView />}
          {view === 'transfers' && <TransfersView />}
          {view === 'balance' && <BalanceView />}
          {view === 'statement' && <StatementView />}
          {view === 'slides' && <SlidesView />}
          {view === 'settings' && <SettingsView />}
          {view === 'versions' && <VersionsView />}
          {view === 'budget' && <BudgetView />}
        </div>
      </div>
    </div>
  );
}

function NavItem({ id, label, icon, extra, title, disabled }: { id: View; label: string; icon: React.ReactNode; extra?: React.ReactNode; title?: string; disabled?: boolean }) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <button className={view === id ? 'active' : ''} disabled={disabled} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}
      title={disabled ? 'Start et financial statement først (øverst i menuen)' : title}>
      {icon}
      {label}
      {extra && <span className="nav-extra">{extra}</span>}
    </button>
  );
}

function TopBar() {
  const view = useStore((s) => s.view);
  const storageError = useStore((s) => s.storageError);
  const save = useStore((s) => s.saveStatus);
  const setView = useStore((s) => s.setView);
  const period = usePeriod();
  return (
    <>
      <div className="topbar">
        {view === 'budget'
          ? <span className="crumb">Dagligt budget · <b>Abonnementer & regninger</b> <span className="muted">(adskilt fra financial statementet)</span></span>
          : period
          ? <span className="crumb">Financial statement · <b>{period.name}</b> <span className="muted">({period.start} – {period.end})</span></span>
          : <span className="crumb muted">Intet financial statement valgt</span>}
        <span className="spacer" />
        {save.mode === 'file' && save.client
          ? <span className="chip user" title={`${save.client === 'folder' ? `Krypteret (AES-256) i mappen ${save.dir} på denne computer` : 'I browserens lager på denne computer (ikke krypteret)'}${save.savedAt ? ` · senest gemt ${new Date(save.savedAt).toLocaleString('da-DK')}` : ''}`}>
              {save.client === 'folder' ? `🔒 Gemt i ${save.dir}` : '💾 Gemt i browseren'}</span>
          : save.mode === 'file'
          ? <span className="chip user" title={`Krypteret (AES-256) i ${save.dir}/finstate.json${save.savedAt ? ` · senest gemt ${new Date(save.savedAt).toLocaleString('da-DK')}` : ''}`}>🔒 Krypteret og gemt</span>
          : save.mode === 'error' ? <span className="chip review" title={save.error}>⚠ Ikke gemt</span> : null}
        <button className="btn sm" onClick={() => setView('versions')} title="Gem en version (milepæl), se ændringer siden – og gå tilbage">🕘 Versioner</button>
      </div>
      {storageError && <div className="banner error" style={{ margin: '12px 24px 0' }}>{storageError}</div>}
      {save.mode === 'error' && save.error && <div className="banner warn" style={{ margin: '12px 24px 0' }}>{save.error}</div>}
    </>
  );
}
