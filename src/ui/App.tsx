import { StatementSwitcher } from './components/PeriodPrompt';
import { NEEDS_REVIEW } from '../domain/classify';
import { inPeriod } from '../domain/engine';
import { useEngine, usePeriod } from '../store/actions';
import { useStore, type View } from '../store/store';
import { exportBackup } from './backup';
import { ViewHelp, nextStepOf, useGuide } from './components/Guide';
import { BalanceView } from './views/BalanceView';
import { ImportView } from './views/ImportView';
import { LedgerView } from './views/LedgerView';
import { OverviewView } from './views/OverviewView';
import { SettingsView } from './views/SettingsView';
import { SlidesView } from './views/SlidesView';
import { StatementView } from './views/StatementView';
import { TransfersView } from './views/TransfersView';

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
  return (
    <div className="app">
      <nav className="nav" aria-label="Hovedmenu">
        <div className="brand">◐ Finstate <small>lokalt & privat</small></div>
        <StatementSwitcher />
        <NavItem id="overview" label="Overblik" icon={<span className="step">⌂</span>} />

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
        <div className="nav-foot">Data forlader aldrig din computer. Gemmes i denne browser – tag backup.</div>
      </nav>
      <div className="main">
        <TopBar />
        <div className="content">
          {view !== 'overview' && <div className="no-print" style={{ marginBottom: 16 }}><ViewHelp view={view} /></div>}
          {view === 'overview' && <OverviewView />}
          {view === 'import' && <ImportView />}
          {view === 'ledger' && <LedgerView />}
          {view === 'transfers' && <TransfersView />}
          {view === 'balance' && <BalanceView />}
          {view === 'statement' && <StatementView />}
          {view === 'slides' && <SlidesView />}
          {view === 'settings' && <SettingsView />}
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
  const data = useStore((s) => s.data);
  const storageError = useStore((s) => s.storageError);
  const period = usePeriod();
  const { lastExportAt, lastChangeAt } = data.settings;
  const dirty = !!lastChangeAt && (!lastExportAt || lastChangeAt > lastExportAt);
  const days = lastExportAt ? Math.floor((Date.now() - Date.parse(lastExportAt)) / 86400000) : null;
  return (
    <>
      <div className="topbar">
        {period
          ? <span className="crumb">Financial statement · <b>{period.name}</b> <span className="muted">({period.start} – {period.end})</span></span>
          : <span className="crumb muted">Intet financial statement valgt</span>}
        <span className="spacer" />
        <span className={`chip ${dirty && data.txs.length ? 'review' : ''}`} title={lastExportAt ? `Sidste backup ${lastExportAt}` : 'Ingen backup endnu'}>
          {dirty ? (days === null ? 'Ingen backup endnu' : `Ændringer siden backup (${days} d.)`) : 'Backup er opdateret'}
        </span>
        <button className={`btn sm ${dirty && data.txs.length ? 'primary' : ''}`} onClick={() => exportBackup('full')}>Eksportér backup</button>
      </div>
      {storageError && <div className="banner error" style={{ margin: '12px 24px 0' }}>{storageError}</div>}
    </>
  );
}
