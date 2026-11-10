import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { inPeriod } from '../../domain/engine';
import { dateDa } from '../../domain/format';
import type { Period } from '../../domain/types';
import { withNewPeriod } from '../../domain/accountTypes';
export { withNewPeriod };
import { inProgress, yearPeriod } from '../../domain/periods';
import { InfoBox, SearchCombo } from './common';
import { usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';

/**
 * Sletter et financial statement: perioden, dens slideshow-tekster og bekræftelser.
 * Transaktioner, kategorier, regler og værdier på dine poster bevares (de er ikke knyttet til perioden).
 */
export function deleteStatement(id: string) {
  const { update, setPeriod, periodId } = useStore.getState();
  update((d) => {
    const slideNotes = { ...d.slideNotes };
    delete slideNotes[id];
    return {
      ...d,
      periods: d.periods.filter((p) => p.id !== id).map((p) => (p.compareToId?.split('#')[0] === id ? { ...p, compareToId: undefined } : p)),
      slideNotes,
    };
  });
  if (periodId === id) setPeriod(undefined);
}

/** Opretter perioden (hvis den ikke findes) og gør den til det aktuelle financial statement. */
export function startStatement(p: Period) {
  const { update, setPeriod, setView, data } = useStore.getState();
  const existing = data.periods.find((x) => x.start === p.start && x.end === p.end);
  if (!existing) update((d) => withNewPeriod(d, p));
  setPeriod(existing?.id ?? p.id);
  setView('overview');
}

/** Formular: vælg år. Et financial statement er altid årligt – også mens året er i gang. */
export function PeriodForm({ onDone, submitLabel = 'Start', onCancel, secondary }: { onDone?: () => void; submitLabel?: string; onCancel?: () => void; secondary?: boolean }) {
  const data = useStore((s) => s.data);
  const years = [...new Set(data.txs.map((t) => Number(t.date.slice(0, 4))))];
  const thisYear = new Date().getFullYear();
  const yearOptions = [...new Set([...years, thisYear, thisYear - 1, thisYear - 2])].sort((a, b) => b - a);
  // Standard: er der gået et halvt år, starter man på i år (og kan vise 1. halvår i Regnskab) – ellers sidste år.
  const defaultYear = new Date().getMonth() >= 6 ? thisYear : thisYear - 1;
  const [year, setYear] = useState<number>(defaultYear);
  const [name, setName] = useState('');

  const preset = yearPeriod(year);
  const candidate: Period = { ...preset, name: name.trim() || preset.name };
  const exists = data.periods.find((p) => p.start === candidate.start && p.end === candidate.end);
  const txCount = data.txs.filter((t) => inPeriod(t, candidate)).length;
  const running = inProgress(candidate);
  const submit = () => {
    startStatement(exists ?? candidate);
    onDone?.();
  };

  return (
    <div className="period-form" onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}>
      <div className="row">
        <label className="field">År
          <SearchCombo className="combo-narrow" options={yearOptions.map((y) => ({ id: String(y), label: String(y) }))} value={String(year)}
            onChange={(v) => { if (v) setYear(Number(v)); }} searchPlaceholder="Søg år…" ariaLabel="År" />
        </label>
        <label className="field grow">Navn
          <input value={name} placeholder={preset.name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <div className="row small" style={{ marginTop: 12, flexWrap: 'nowrap' }}>
        <span className="ink2 ellipsis">
          {dateDa(candidate.start)} – {dateDa(candidate.end)}{data.txs.length ? ` · ${txCount} transaktioner` : ''}
          {running && !exists && <> · året er i gang</>}
          {exists && <> · <b>findes allerede</b></>}
        </span>
        <span className="spacer" />
        {onCancel && <button className="btn sm ghost" onClick={onCancel}>Annullér</button>}
        <button className={`btn sm ${secondary ? '' : 'primary'}`} style={{ whiteSpace: 'nowrap' }} onClick={submit}>{exists ? `Åbn ${exists.name}` : submitLabel}</button>
      </div>
    </div>
  );
}

/** Stort startkort – vises når der ikke er valgt et financial statement. */
export function NoPeriod({ title = 'Start et financial statement' }: { title?: string }) {
  const periods = useStore((s) => s.data.periods);
  // Mangler opsætningen (kategoritræet), er det næste skridt dér – så denne knap er ikke blå endnu.
  const setupMissing = useStore((s) => s.data.categories.length === 0);
  const setPeriod = useStore((s) => s.setPeriod);
  return (
    <div className={`card start-card ${setupMissing ? 'waiting' : ''}`} style={{ maxWidth: 640 }}>
      <h2>{setupMissing ? `Derefter: ${title.toLowerCase()}` : title}</h2>
      <p className="ink2" style={{ marginBottom: 14 }}>
        Et financial statement dækker et helt år. Vælg året, så tager guiden dig igennem import, kategorisering og balance for det.
      </p>
      <InfoBox label="Midt i året?">Er året ikke slut endnu, så start bare på det alligevel. Under Regnskab kan du vælge kun at vise 1. halvår – eller hele året indtil nu.</InfoBox>
      <PeriodForm submitLabel="Start financial statement" secondary={setupMissing} />
      {periods.length > 0 && (
        <div className="row small" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          <span className="ink2">Eller fortsæt:</span>
          {[...periods].sort((a, b) => (a.end < b.end ? 1 : -1)).map((p) => (
            <button key={p.id} className="btn sm" onClick={() => setPeriod(p.id)}>{p.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Øverst i menuen: hvilket financial statement man arbejder på – skift eller start et nyt. */
export function StatementSwitcher() {
  const period = usePeriod();
  const periods = useStore((s) => s.data.periods);
  const setPeriod = useStore((s) => s.setPeriod);
  const setupMissing = useStore((s) => s.data.categories.length === 0);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Popoveren er "fixed", så den ikke klippes af menuens scroll-område.
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const close = () => { setOpen(false); setCreating(false); setConfirmDelete(undefined); };
  const toDelete = periods.find((p) => p.id === confirmDelete);
  const sorted = [...periods].sort((a, b) => (a.end < b.end ? 1 : -1));

  return (
    <>
      <button ref={btn} className={`statement-switch ${period ? '' : setupMissing ? 'empty waiting' : 'empty'}`} onClick={() => { setOpen(!open); setCreating(!periods.length); }} aria-expanded={open}>
        <span className="statement-label">Financial statement</span>
        {period ? (
          <>
            <span className="statement-name">{period.name} <span className="caret-down">▾</span></span>
            <span className="statement-dates">{dateDa(period.start)} – {dateDa(period.end)}</span>
          </>
        ) : (
          <span className="statement-name">+ Start nyt <span className="caret-down">▾</span></span>
        )}
      </button>
      {open && (
        <div ref={pop} className="popover fixed" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="Financial statements">
          {creating ? (
            <>
              <div className="popover-title">Nyt financial statement</div>
              <PeriodForm onDone={close} onCancel={sorted.length ? () => setCreating(false) : close} />
            </>
          ) : toDelete ? (
            <div className="delete-confirm" role="alertdialog" aria-label={`Slet ${toDelete.name}`}>
              <div className="popover-title" style={{ color: 'var(--critical)' }}>Slet financial statement</div>
              <p><b>Er du helt sikker på, at du vil slette {toDelete.name}?</b></p>
              <p className="small ink2" style={{ margin: '6px 0' }}>
                Det fjerner perioden ({dateDa(toDelete.start)} – {dateDa(toDelete.end)}), dens slideshow-tekster og bekræftelsen af balancen. Det kan ikke fortrydes, medmindre du har en backup.
              </p>
              <p className="small muted">Dine transaktioner, kategorier, regler og værdier på dine poster bevares – du kan altid oprette perioden igen.</p>
              <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                <button className="btn sm" autoFocus onClick={() => setConfirmDelete(undefined)}>Annullér</button>
                <button className="btn sm danger-solid" onClick={() => { deleteStatement(toDelete.id); setConfirmDelete(undefined); if (periods.length <= 1) close(); }}>Ja, slet {toDelete.name}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="popover-title">Dine financial statements</div>
              <div className="col" style={{ gap: 2 }}>
                {sorted.map((p) => (
                  <div key={p.id} className="period-row">
                    <button className={`period-option ${p.id === period?.id ? 'on' : ''}`} onClick={() => { setPeriod(p.id); close(); }}>
                      <span className="period-check">{p.id === period?.id ? '✓' : ''}</span>
                      <b>{p.name}</b>
                      <span className="small muted">{dateDa(p.start)} – {dateDa(p.end)}</span>
                    </button>
                    <button className="btn sm ghost period-delete" title={`Slet ${p.name}`} aria-label={`Slet ${p.name}`} onClick={() => setConfirmDelete(p.id)}>🗑</button>
                  </div>
                ))}
              </div>
              <button className="btn sm primary" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} onClick={() => setCreating(true)}>+ Nyt financial statement</button>
            </>
          )}
        </div>
      )}
    </>
  );
}
