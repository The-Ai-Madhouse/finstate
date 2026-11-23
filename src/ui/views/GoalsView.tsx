import { useEffect, useMemo, useState } from 'react';
import { dateDa } from '../../domain/format';
import {
  GOAL_KINDS, PRIORITY_LABEL, bufferSuggestion, goalPlan, goalsOverview, kindOf, savingsCapacity, type GoalPlan, type GoalStatus,
} from '../../domain/goals';
import { budgetItems, perMonth } from '../../domain/subscriptions';
import type { Goal, GoalCost, GoalKind } from '../../domain/types';
import { uid } from '../../domain/util';
import { useEngine } from '../../store/actions';
import { useStore } from '../../store/store';
import { AmountInput, InfoBox, Tile } from '../components/common';

/**
 * Mål: skriv dine opsparingsmål ind og se, hvad der skal til – og om det er realistisk ud fra dine egne bankdata.
 * Kun planlægning: flytter ingen penge og påvirker hverken regnskabet eller det daglige budget.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
const monthYear = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const ymLabel = (ym: string) => monthYear(`${ym}-01`);
const krf = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 });
const kr = (ore: number) => `${krf.format(Math.round(ore / 100))} kr.`;
const months = (n: number) => `${n} ${n === 1 ? 'måned' : 'måneder'}`;

const STATUS: Record<GoalStatus, { label: string; cls: string }> = {
  done: { label: 'Nået 🎉', cls: 'ok' },
  ontrack: { label: 'På sporet', cls: 'ok' },
  behind: { label: 'Bagud', cls: 'warn' },
  overdue: { label: 'Datoen er passeret', cls: 'bad' },
  noplan: { label: 'Uden månedsbeløb', cls: 'info' },
  open: { label: 'Ingen dato', cls: 'info' },
};

export function GoalsView() {
  const e = useEngine();
  const update = useStore((s) => s.update);
  const goals = e.data.goals ?? [];
  const today = todayIso();
  const capacity = useMemo(() => savingsCapacity(e.data, e.resolved), [e.data, e.resolved]);
  const fixedPerMonth = useMemo(() => budgetItems(e.data, e.resolved).filter((i) => i.active).reduce((s, i) => s + perMonth(i), 0), [e.data, e.resolved]);
  const o = goalsOverview(goals, today, capacity);
  const [editing, setEditing] = useState<Goal | 'new'>();
  const sorted = [...goals].sort((a, b) => a.priority - b.priority || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'));

  const save = (g: Goal) => { update((d) => ({ ...d, goals: [...(d.goals ?? []).filter((x) => x.id !== g.id), g] })); setEditing(undefined); };
  const remove = (id: string) => { update((d) => ({ ...d, goals: (d.goals ?? []).filter((x) => x.id !== id) })); setEditing(undefined); };

  const demand = Math.max(o.needPerMonth, o.plannedPerMonth);
  const verdictText = {
    realistic: { cls: 'ok', title: 'Det ser realistisk ud', text: `Dine mål kræver ${kr(demand)} om måneden – ${Math.round((o.share ?? 0) * 100)} % af det, du i snit har tilbage.` },
    tight: { cls: 'warn', title: 'Det bliver stramt', text: `Dine mål kræver ${kr(demand)} om måneden – ${Math.round((o.share ?? 0) * 100)} % af det, du i snit har tilbage. Der er næsten intet til uforudsete udgifter.` },
    unrealistic: { cls: 'bad', title: 'Det ser ikke realistisk ud', text: capacity && capacity.net <= 0
      ? `Du har i snit ikke noget tilbage om måneden (${kr(capacity.net)}). Målene kræver ${kr(demand)} om måneden – skær i udgifterne, flyt datoerne eller gør målene mindre.`
      : `Dine mål kræver ${kr(demand)} om måneden, men du har i snit ${kr(capacity?.net ?? 0)} tilbage. Flyt datoerne, gør målene mindre – eller prioritér.` },
    unknown: { cls: 'info', title: 'Hvor realistisk er det?', text: capacity ? 'Giv dine mål en dato eller et månedligt beløb, så kan Finstate se, om det hænger sammen med det, du har tilbage hver måned.' : 'Importér nogle hele måneders bankdata, så kan Finstate se, hvad du i snit har tilbage om måneden – og om dine mål er realistiske.' },
  }[o.verdict];

  return (
    <div className="stack goals">
      <div className="row bud-head">
        <h1 className="grow">Mål</h1>
        <button className="btn primary" onClick={() => setEditing('new')}>＋ Nyt mål</button>
      </div>

      {!goals.length ? (
        <div className="card goal-empty">
          <h2>Hvad sparer du op til?</h2>
          <p className="ink2">
            En rejse, en ferie, en buffer, en ny bil … Skriv målet ind med beløb og dato, så regner Finstate ud, hvad du skal spare op hver måned –
            og om det er realistisk ud fra det, du faktisk har tilbage hver måned i dine bankdata. Det er kun planlægning: der flyttes ingen penge.
          </p>
          <div className="row" style={{ gap: 8 }}>
            {GOAL_KINDS.slice(0, 4).map((k) => (
              <button key={k.id} className="btn" onClick={() => setEditing({ ...blank(), kind: k.id, name: k.id === 'buffer' ? 'Buffer' : '' })}>{k.icon} {k.label}</button>
            ))}
          </div>
        </div>
      ) : (<>
        <div className="tiles bud-tiles">
          <Tile label="Dine mål kræver" value={`${kr(o.needPerMonth)}/md.`} delta={o.needPerMonth ? 'for at nå dem til tiden' : 'giv målene en dato'} />
          <Tile label="Du har i snit tilbage" value={capacity ? `${kr(capacity.net)}/md.` : '–'}
            delta={capacity ? `${ymLabel(capacity.from)} – ${ymLabel(capacity.to)} (${months(capacity.months)})` : 'importér bankdata'} />
          <Tile label="Du planlægger at spare" value={`${kr(o.plannedPerMonth)}/md.`} delta={o.plannedPerMonth ? 'dine egne beløb pr. mål' : 'skriv et beløb pr. mål'} />
          <Tile label="Mangler i alt" value={kr(o.left)} delta={`${goals.length} ${goals.length === 1 ? 'mål' : 'mål'}`} />
        </div>

        <div className={`goal-verdict ${verdictText.cls}`}>
          <b>{verdictText.title}</b>
          <span>{verdictText.text}</span>
          {capacity && (
            <span className="small">
              I snit {kr(capacity.income)} ind og {kr(capacity.expense)} ud om måneden (uden overførsler mellem dine egne konti).
              {o.plannedPerMonth > 0 && o.plannedPerMonth < o.needPerMonth && ` Dine egne beløb (${kr(o.plannedPerMonth)}/md.) er ${kr(o.needPerMonth - o.plannedPerMonth)} for lidt til at nå alt til tiden.`}
            </span>
          )}
        </div>

        <div className="goal-grid">
          {sorted.map((g) => <GoalCard key={g.id} g={g} p={o.plans.get(g.id)!} capacity={capacity?.net} onEdit={() => setEditing(g)} />)}
        </div>

        <InfoBox label="Hvordan regner Finstate?">
          <b>Pr. måned</b> = det, der mangler, delt ud på de hele måneder til datoen. <b>Du har tilbage</b> = indtægter minus udgifter i dine
          seneste hele måneder med bankdata (højst 6), uden overførsler mellem dine egne konti. Målene er <b>realistiske</b>, når de tilsammen
          kræver højst 80 % af det, du har tilbage – resten er luft til det uforudsete. Prioriteten bestemmer kun rækkefølgen her på siden.
        </InfoBox>
      </>)}

      {editing && (
        <GoalDialog goal={editing === 'new' ? blank() : editing} isNew={editing === 'new' || !goals.some((x) => x.id === (editing as Goal).id)} today={today}
          capacity={capacity?.net} fixedPerMonth={fixedPerMonth} onClose={() => setEditing(undefined)} onSave={save}
          onRemove={editing !== 'new' ? () => remove((editing as Goal).id) : undefined} />
      )}
    </div>
  );
}

const blank = (): Goal => ({ id: uid('goal'), name: '', kind: 'travel', target: 0, saved: 0, priority: 2, createdAt: new Date().toISOString() });

function GoalCard({ g, p, capacity, onEdit }: { g: Goal; p: GoalPlan; capacity?: number; onEdit: () => void }) {
  const k = kindOf(g.kind);
  const st = STATUS[p.status];
  return (
    <button className={`card goal-card kind-${g.kind}`} onClick={onEdit} title="Ret målet">
      <div className="goal-head">
        <span className="goal-icon" aria-hidden>{k.icon}</span>
        <span className="grow">
          <b className="goal-name">{g.name || k.label}</b>
          <span className="muted small">{k.label} · prioritet {PRIORITY_LABEL[g.priority].toLowerCase()}{g.deadline ? ` · ${dateDa(g.deadline)}` : ''}</span>
        </span>
        <span className={`goal-status ${st.cls}`}>{st.label}</span>
      </div>

      {p.status === 'done' ? (
        <div className="goal-big num">{kr(p.target)}<span className="goal-big-sub">er sparet op</span></div>
      ) : p.needPerMonth !== undefined ? (
        <div className="goal-big num">{kr(p.needPerMonth)}<span className="goal-big-sub">om måneden i {months(p.monthsLeft!)} for at nå {kr(p.target)}</span></div>
      ) : (
        <div className="goal-big num">{kr(p.left)}<span className="goal-big-sub">mangler – giv målet en dato for at se, hvad det kræver pr. måned</span></div>
      )}

      <div className="goal-bar" role="img" aria-label={`${Math.round(p.progress * 100)} % sparet`}><span style={{ width: `${p.progress * 100}%` }} /></div>
      <div className="row small goal-numbers">
        <span><b className="num">{kr(p.saved)}</b> sparet</span>
        <span className="spacer" />
        <span className="muted">{Math.round(p.progress * 100)} % af {kr(p.target)}</span>
      </div>

      {p.status !== 'done' && (
        <div className="goal-lines small">
          {g.monthly ? (
            <div>Med dine <b>{kr(g.monthly)}/md.</b> når du det i <b>{monthYear(p.reachedAt!)}</b>
              {p.lateBy !== undefined && p.lateBy > 0 ? <span className="neg"> – {months(p.lateBy)} for sent</span> : p.lateBy !== undefined && p.lateBy < 0 ? <span className="pos"> – {months(-p.lateBy)} før tid</span> : null}.</div>
          ) : <div className="muted">Skriv, hvor meget du kan spare pr. måned, så ser du, hvornår du når det.</div>}
          {capacity !== undefined && capacity > 0 && p.needPerMonth !== undefined && (
            <div className="muted">Det er {Math.round((p.needPerMonth / capacity) * 100)} % af det, du i snit har tilbage om måneden.</div>
          )}
        </div>
      )}

      {!!g.costs?.length && (
        <div className="goal-costs small">
          {g.costs.map((c) => <span key={c.id}>{c.label} <b className="num">{kr(c.amount)}</b></span>)}
        </div>
      )}
      {g.note && <div className="small ink2 goal-note">{g.note}</div>}
    </button>
  );
}

function GoalDialog({ goal, isNew, today, capacity, fixedPerMonth, onClose, onSave, onRemove }: {
  goal: Goal; isNew: boolean; today: string; capacity?: number; fixedPerMonth: number; onClose: () => void; onSave: (g: Goal) => void; onRemove?: () => void;
}) {
  const [g, setG] = useState<Goal>(goal);
  const [useCosts, setUseCosts] = useState(!!goal.costs?.length);
  const set = (patch: Partial<Goal>) => setG((x) => ({ ...x, ...patch }));
  const costs = g.costs ?? [];
  const setCost = (i: number, patch: Partial<GoalCost>) => set({ costs: costs.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const final: Goal = { ...g, name: g.name.trim(), costs: useCosts ? costs.filter((c) => c.label.trim() || c.amount) : undefined, note: g.note?.trim() || undefined };
  const p = goalPlan(final, today);
  const ok = final.name !== '' && p.target > 0;
  const buffer = bufferSuggestion(fixedPerMonth);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <form className="card modal goal-dialog" role="dialog" aria-modal aria-label={isNew ? 'Nyt mål' : `Ret ${goal.name}`}
        onSubmit={(ev) => { ev.preventDefault(); if (ok) onSave(final); }}>
        <div className="card-head">
          <h2 className="grow">{isNew ? 'Nyt mål' : `Ret ${goal.name}`}</h2>
          <button type="button" className="btn sm ghost" onClick={onClose} aria-label="Luk">✕</button>
        </div>

        <div className="colchecks" role="radiogroup" aria-label="Slags mål">
          {GOAL_KINDS.map((k) => (
            <button type="button" key={k.id} role="radio" aria-checked={g.kind === k.id} className={`colcheck ${g.kind === k.id ? 'on' : ''}`}
              onClick={() => set({ kind: k.id as GoalKind })}>{k.icon} {k.label}</button>
          ))}
        </div>

        <div className="goal-form">
          <label className="wide">Navn<input value={g.name} onChange={(ev) => set({ name: ev.target.value })} placeholder="fx Japan i påsken 2027" autoFocus={isNew} /></label>

          <div className="wide goal-target">
            <div className="row" style={{ gap: 8 }}>
              <span className="goal-label">Hvad koster det?</span>
              <div className="seg" role="radiogroup">
                <button type="button" role="radio" aria-checked={!useCosts} className={!useCosts ? 'on plain' : ''} onClick={() => setUseCosts(false)}>Ét beløb</button>
                <button type="button" role="radio" aria-checked={useCosts} className={useCosts ? 'on plain' : ''}
                  onClick={() => { setUseCosts(true); if (!costs.length) set({ costs: [{ id: uid('c'), label: '', amount: 0 }] }); }}>Del op i poster</button>
              </div>
            </div>
            {!useCosts ? (
              <AmountInput className="sm" value={g.target || undefined} onCommit={(v) => set({ target: Math.abs(v ?? 0) })} onLive={(v) => set({ target: Math.abs(v ?? 0) })} placeholder="0" ariaLabel="Målbeløb" />
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {costs.map((c, i) => (
                  <div key={c.id} className="row goal-cost" style={{ gap: 6 }}>
                    <input className="sm grow" value={c.label} placeholder="fx Fly, hotel, lommepenge" onChange={(ev) => setCost(i, { label: ev.target.value })} aria-label={`Post ${i + 1}`} />
                    <AmountInput className="sm" value={c.amount || undefined} onCommit={(v) => setCost(i, { amount: Math.abs(v ?? 0) })} onLive={(v) => setCost(i, { amount: Math.abs(v ?? 0) })} placeholder="0" ariaLabel={`Beløb for post ${i + 1}`} />
                    <button type="button" className="btn sm ghost" onClick={() => set({ costs: costs.filter((_, j) => j !== i) })} aria-label="Fjern post">✕</button>
                  </div>
                ))}
                <div className="row">
                  <button type="button" className="btn sm ghost" onClick={() => set({ costs: [...costs, { id: uid('c'), label: '', amount: 0 }] })}>＋ Tilføj post</button>
                  <span className="spacer" />
                  <span className="small">I alt <b className="num">{kr(p.target)}</b></span>
                </div>
              </div>
            )}
            {g.kind === 'buffer' && fixedPerMonth > 0 && (
              <div className="small ink2">
                Tommelfingerregel: 3 måneders faste udgifter = <b>{kr(buffer)}</b> (dine faste udgifter er {kr(fixedPerMonth)}/md. under Abonnementer).{' '}
                {!useCosts && g.target !== buffer && <button type="button" className="linkish" onClick={() => set({ target: buffer })}>Brug det</button>}
              </div>
            )}
          </div>

          <label>Allerede sparet<AmountInput className="sm" value={g.saved || undefined} onCommit={(v) => set({ saved: Math.abs(v ?? 0) })} onLive={(v) => set({ saved: Math.abs(v ?? 0) })} placeholder="0" ariaLabel="Allerede sparet" /></label>
          <label>Hvornår skal pengene være der?<input type="date" value={g.deadline ?? ''} min={today} onChange={(ev) => set({ deadline: ev.target.value || undefined })} /></label>
          <label>Jeg kan spare pr. måned <span className="muted">(valgfri)</span>
            <AmountInput className="sm" value={g.monthly || undefined} onCommit={(v) => set({ monthly: Math.abs(v ?? 0) || undefined })} onLive={(v) => set({ monthly: Math.abs(v ?? 0) || undefined })} placeholder="0" ariaLabel="Spar pr. måned" />
          </label>
          <label>Prioritet
            <select value={g.priority} onChange={(ev) => set({ priority: Number(ev.target.value) as Goal['priority'] })}>
              {([1, 2, 3] as const).map((n) => <option key={n} value={n}>{PRIORITY_LABEL[n]}</option>)}
            </select>
          </label>
          <label className="wide">Noter <span className="muted">(valgfri)</span><textarea rows={2} value={g.note ?? ''} onChange={(ev) => set({ note: ev.target.value })} placeholder="Hvorfor, hvem, hvad er vigtigt …" /></label>
        </div>

        {p.target > 0 && (
          <div className="goal-preview">
            {p.status === 'done' ? <b>Du har allerede sparet det hele op. 🎉</b> : p.needPerMonth !== undefined ? (
              <><b>Spar {kr(p.needPerMonth)} om måneden</b> i {months(p.monthsLeft!)} for at have {kr(p.target)} til {dateDa(g.deadline!)}.
                {capacity !== undefined && capacity > 0 && <> Det er {Math.round((p.needPerMonth / capacity) * 100)} % af det, du i snit har tilbage om måneden ({kr(capacity)}).</>}</>
            ) : p.status === 'overdue' ? <>Datoen er passeret – vælg en ny.</> : <>Der mangler {kr(p.left)}. Vælg en dato for at se, hvad det kræver pr. måned.</>}
            {g.monthly && p.reachedAt && p.status !== 'done' ? <> Med {kr(g.monthly)}/md. når du det i {monthYear(p.reachedAt)}.</> : null}
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          {onRemove && <button type="button" className="btn danger" onClick={() => { if (confirm(`Slet målet "${goal.name}"?`)) onRemove(); }}>Slet</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Annullér</button>
          <button type="submit" className="btn primary" disabled={!ok}>{isNew ? 'Opret mål' : 'Gem'}</button>
        </div>
      </form>
    </div>
  );
}
