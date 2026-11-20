import { useEffect, useMemo, useState } from 'react';
import { dateDa } from '../../domain/format';
import {
  CADENCES, CADENCE_LABEL, CADENCE_MONTHS, CADENCE_PER, addMonthsKeepDay, budgetItems, detectSubscriptions, nextOccurrence,
  occurrences, paidTx, perMonth, removeSubscription, resetSubscription, restoreSubscription, saveSubscription, subName,
  type BudgetItem, type Occurrence,
} from '../../domain/subscriptions';
import type { Cadence, Subscription, Tx } from '../../domain/types';
import { hash, uid } from '../../domain/util';
import { useEngine } from '../../store/actions';
import { useStore } from '../../store/store';
import { AccountSelect, AmountInput } from '../components/common';

/**
 * Dagligt budget: faste udgifter og abonnementer i en kalender, så man kan se regningerne, før de bliver trukket.
 * Helt adskilt fra financial statementet – kræver ingen periode og ændrer ikke regnskabet.
 */

const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const WEEKDAYS = ['M', 'T', 'O', 'T', 'F', 'L', 'S'];

const pad = (n: number) => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const monthEnd = (iso: string) => addDaysIso(addMonthsKeepDay(monthStart(iso), 1), -1);
function addDaysIso(iso: string, days: number) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const monthName = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1];
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "4. dec" (+ år, hvis det ikke er i år). */
const dayMonth = (iso: string, today: string) => `${Number(iso.slice(8, 10))}. ${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]}${iso.slice(0, 4) !== today.slice(0, 4) ? ` ${iso.slice(0, 4)}` : ''}`;

const krf = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 });
/** 39700 øre → "397 kr." */
const kr = (ore: number) => `${krf.format(Math.round(ore / 100))} kr.`;

/** Fast farve pr. navn (avatar). */
const HUES = [152, 12, 205, 280, 38, 330, 100, 230];
const hueOf = (name: string) => HUES[parseInt(hash(name.toLowerCase()).slice(-4), 36) % HUES.length];
const initials = (name: string) => {
  const w = name.replace(/[^A-Za-zÆØÅæøåÄÖÜäöüÉé0-9 ]/g, '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '?') + (w.length > 1 ? w[1][0] : w[0]?.[1] ?? '')).toUpperCase();
};

function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`bud-avatar ${size}`} style={{ ['--h' as string]: hueOf(name) }} aria-hidden>{initials(name)}</span>;
}

const SOURCE_LABEL: Record<BudgetItem['source'], string> = { detected: 'Fundet automatisk', edited: 'Rettet af dig', manual: 'Tilføjet af dig' };

export function BudgetView() {
  const e = useEngine();
  const { data } = e;
  const update = useStore((s) => s.update);
  const today = todayIso();
  const detected = useMemo(() => detectSubscriptions(data, e.resolved), [data, e.resolved]);
  const items = useMemo(() => budgetItems(data, e.resolved, detected), [data, e.resolved, detected]);
  const active = items.filter((i) => i.active);
  const stopped = items.filter((i) => !i.active);
  const hidden = detected.filter((d) => (data.budget?.dismissed ?? []).includes(d.key));
  const dataEnd = data.txs.reduce((m, t) => (t.date > m ? t.date : m), '');

  const [month, setMonth] = useState(monthStart(today));
  const [day, setDay] = useState<string | undefined>(today);
  const [editing, setEditing] = useState<BudgetItem | 'new' | undefined>();
  const [showHidden, setShowHidden] = useState(false);

  const mEnd = monthEnd(month);
  const monthOcc = useMemo(() => occurrences(items, month, mEnd), [items, month, mEnd]);
  const isCurrent = month === monthStart(today);
  const remaining = isCurrent ? monthOcc.filter((o) => o.date >= today) : monthOcc;
  const remainingSum = remaining.reduce((s, o) => s + o.item.amount, 0);
  const perMonthTotal = active.reduce((s, i) => s + perMonth(i), 0);

  // De store regninger: dem, der ikke kommer hver måned.
  const big = active.filter((i) => i.cadence !== 'monthly');
  const bigPerMonth = big.reduce((s, i) => s + perMonth(i), 0);
  const horizon = addMonthsKeepDay(today, 12);
  const upcoming = useMemo(() => occurrences(items, today, horizon), [items, today, horizon]);
  const nextBig = upcoming.find((o) => o.item.cadence !== 'monthly')
    ?? [...upcoming.filter((o) => o.date <= addDaysIso(today, 45))].sort((a, b) => b.item.amount - a.item.amount)[0];

  // Søjler: de næste 12 måneder.
  const bars = [...Array(12)].map((_, i) => {
    const s = addMonthsKeepDay(monthStart(today), i);
    const occ = occurrences(items, s, monthEnd(s));
    const fixed = occ.filter((o) => o.item.cadence === 'monthly').reduce((a, o) => a + o.item.amount, 0);
    const extra = occ.filter((o) => o.item.cadence !== 'monthly').reduce((a, o) => a + o.item.amount, 0);
    return { s, fixed, extra, total: fixed + extra };
  });
  const avg = Math.round(bars.reduce((a, b) => a + b.total, 0) / bars.length);
  const maxBar = Math.max(1, ...bars.map((b) => b.total));

  const sel = day && day >= month && day <= mEnd ? monthOcc.filter((o) => o.date === day) : [];
  const accountName = (id?: string) => data.accounts.find((a) => a.id === id)?.name;

  const save = (s: Subscription) => { update((d) => saveSubscription(d, s)); setEditing(undefined); };
  const remove = (i: BudgetItem) => { update((d) => removeSubscription(d, i)); setEditing(undefined); };

  return (
    <div className="budget">
      <div className="bud-intro">
        <div>
          <h1>Se regningerne, før de bliver trukket</h1>
          <p className="ink2">
            Dine faste udgifter og abonnementer i en kalender. Finstate finder dem selv i dine importerede bankdata – har den
            taget fejl eller mangler der en, så ret eller tilføj den. Det her er dit daglige budget og påvirker ikke dit financial statement.
          </p>
        </div>
        <button className="btn bud-primary" onClick={() => setEditing('new')}>＋ Tilføj abonnement</button>
      </div>

      {!items.length ? (
        <div className="bud-empty card">
          <h2>Ingen abonnementer endnu</h2>
          <p className="ink2">
            {data.txs.length
              ? 'Finstate fandt ingen faste træk i dine transaktioner. Tilføj dem selv – eller importér flere måneders bankdata, så de kan genkendes.'
              : 'Importér bankdata (under et financial statement → Importér), så finder Finstate dine abonnementer – eller tilføj dem selv.'}
          </p>
          <button className="btn bud-primary" onClick={() => setEditing('new')}>＋ Tilføj abonnement</button>
        </div>
      ) : (
        <div className="bud-grid">
          <section className="bud-hero" aria-label="Kalender">
            <div className="bud-big num">{kr(remainingSum)}</div>
            <div className="bud-sub">
              {isCurrent ? `tilbage at betale i ${monthName(month)}` : `i faste udgifter i ${monthName(month)} ${month.slice(0, 4)}`}
              {' · '}{kr(perMonthTotal)} i faste udgifter om måneden
            </div>
            <div className="bud-monthnav">
              <button className="bud-nav" aria-label="Forrige måned" onClick={() => setMonth(addMonthsKeepDay(month, -1))}>‹</button>
              <button className="bud-month" onClick={() => { setMonth(monthStart(today)); setDay(today); }} title="Gå til i dag">
                {capital(monthName(month))}{month.slice(0, 4) !== today.slice(0, 4) ? ` ${month.slice(0, 4)}` : ''}
              </button>
              <button className="bud-nav" aria-label="Næste måned" onClick={() => setMonth(addMonthsKeepDay(month, 1))}>›</button>
            </div>
            <Calendar month={month} occ={monthOcc} today={today} dataEnd={dataEnd} txById={e.txById} selected={day} onSelect={setDay} />
            {day && day >= month && day <= mEnd && (
              <div className="bud-day">
                <div className="bud-day-head">{capital(dateDa(day))}</div>
                {sel.length ? sel.map((o) => (
                  <OccRow key={o.item.id} o={o} today={today} dataEnd={dataEnd} txById={e.txById} onOpen={() => setEditing(o.item)} />
                )) : <div className="bud-muted">Ingen træk denne dag.</div>}
              </div>
            )}
          </section>

          <section className="bud-side">
            <div className="bud-card">
              <h2>Næste store regning</h2>
              {nextBig ? (
                <button className="bud-bill" onClick={() => setEditing(nextBig.item)}>
                  <Avatar name={nextBig.item.name} />
                  <span className="grow">
                    <b>{nextBig.item.name}</b>
                    <span className="bud-muted">trækkes {dayMonth(nextBig.date, today)}</span>
                  </span>
                  <span className="bud-right">
                    <b className="num">{nextBig.item.variable ? 'ca. ' : ''}{kr(nextBig.item.amount)}</b>
                    <span className="bud-muted">{CADENCE_PER[nextBig.item.cadence]}</span>
                  </span>
                </button>
              ) : <div className="bud-muted">Ingen store regninger på vej.</div>}
            </div>

            <div className="bud-card">
              <h2>{big.length ? <>De store regninger svarer til {kr(bigPerMonth)} om måneden</> : 'De næste 12 måneder'}</h2>
              <div className="bud-bars" role="img" aria-label={`Faste udgifter pr. måned de næste 12 måneder, gennemsnit ${kr(avg)}`}>
                <div className="bud-avg" style={{ bottom: `calc(20px + (100% - 42px) * ${avg / maxBar})` }}><span>gns. {kr(avg).replace(' kr.', ' kr./md.')}</span></div>
                {bars.map((b, i) => (
                  <button key={b.s} className={`bud-bar ${b.s === month ? 'on' : ''}`} title={`${capital(monthName(b.s))} ${b.s.slice(0, 4)}: ${kr(b.total)}${b.extra ? ` (heraf ${kr(b.extra)} store regninger)` : ''}`}
                    onClick={() => { setMonth(b.s); setDay(undefined); }}>
                    <span className="stack-col" style={{ height: `${(b.total / maxBar) * 100}%` }}>
                      {b.extra > 0 && <span className="extra" style={{ flexGrow: b.extra }} />}
                      <span className="fixed" style={{ flexGrow: b.fixed || 0.0001 }} />
                    </span>
                    <span className={`lbl ${i === 0 ? 'now' : ''}`}>{MONTHS_SHORT[Number(b.s.slice(5, 7)) - 1]}</span>
                  </button>
                ))}
              </div>
              <div className="bud-legend"><span><i className="sw fixed" />hver måned</span><span><i className="sw extra" />store regninger</span></div>
            </div>
          </section>
        </div>
      )}

      {items.length > 0 && (
        <section className="bud-card bud-list">
          <div className="bud-list-head">
            <h2>Abonnementer og faste udgifter <span className="bud-count">{active.length}</span></h2>
            <span className="grow" />
            <button className="btn sm" onClick={() => setEditing('new')}>＋ Tilføj</button>
          </div>
          {dataEnd && <p className="bud-muted small">Fundet i dine bankdata til og med {dateDa(dataEnd)}. Klik på et abonnement for at rette det.</p>}
          <SubList items={active} today={today} accountName={accountName} onOpen={setEditing} />
          {stopped.length > 0 && (<>
            <h3 className="bud-h3">Måske stoppet</h3>
            <p className="bud-muted small">Er ikke trukket i et stykke tid. Ret dem, hvis de stadig kører – ellers skjul dem.</p>
            <SubList items={stopped} today={today} accountName={accountName} onOpen={setEditing} stopped />
          </>)}
          {hidden.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button className="btn ghost sm" onClick={() => setShowHidden((x) => !x)}>{showHidden ? '▾' : '▸'} Skjulte ({hidden.length})</button>
              {showHidden && (
                <ul className="bud-rows">
                  {hidden.map((h) => (
                    <li key={h.key} className="bud-row muted-row">
                      <Avatar name={h.name} size="sm" />
                      <span className="grow">{h.name} <span className="bud-muted">· {CADENCE_LABEL[h.cadence].toLowerCase()} · {kr(h.amount)}</span></span>
                      <button className="btn sm" onClick={() => update((d) => restoreSubscription(d, h.key))}>Vis igen</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {editing && (
        <SubDialog item={editing === 'new' ? undefined : editing} today={today} onClose={() => setEditing(undefined)} onSave={save}
          onRemove={editing !== 'new' ? () => remove(editing) : undefined}
          onReset={editing !== 'new' && editing.source === 'edited' && editing.key ? () => { update((d) => resetSubscription(d, editing.key!)); setEditing(undefined); } : undefined} />
      )}
    </div>
  );
}

function Calendar({ month, occ, today, dataEnd, txById, selected, onSelect }: {
  month: string; occ: Occurrence[]; today: string; dataEnd: string; txById: Map<string, Tx>; selected?: string; onSelect: (d: string) => void;
}) {
  const first = new Date(month + 'T12:00:00Z');
  const lead = (first.getUTCDay() + 6) % 7; // mandag først
  const days = Number(monthEnd(month).slice(8, 10));
  const byDay = new Map<string, Occurrence[]>();
  for (const o of occ) byDay.set(o.date, [...(byDay.get(o.date) ?? []), o]);
  return (
    <div className="bud-cal" role="grid" aria-label={`Kalender for ${monthName(month)}`}>
      {WEEKDAYS.map((w, i) => <div key={i} className="bud-wd" role="columnheader">{w}</div>)}
      {[...Array(lead)].map((_, i) => <div key={`l${i}`} />)}
      {[...Array(days)].map((_, i) => {
        const d = `${month.slice(0, 8)}${pad(i + 1)}`;
        const list = byDay.get(d) ?? [];
        const paid = list.length > 0 && list.every((o) => paidTx(o.item, o.date, txById));
        const known = d <= dataEnd; // har vi bankdata for dagen?
        const missed = list.length > 0 && !paid && known && d < today;
        const cls = ['bud-cell', list.length ? 'has' : '', d === today ? 'today' : '', d === selected ? 'sel' : '', d < today ? 'past' : ''].join(' ');
        return (
          <button key={d} className={cls} role="gridcell" aria-selected={d === selected} onClick={() => onSelect(d)}
            aria-label={`${i + 1}. ${monthName(month)}${list.length ? `: ${list.map((o) => o.item.name).join(', ')}` : ''}${paid ? ' – betalt' : ''}`}>
            <span className="n">{i + 1}</span>
            {paid && <span className="bud-check" title="Betalt">✓</span>}
            {missed && <span className="bud-miss" title="Ikke fundet i bankdata">!</span>}
            {list.length > 0 && (
              <span className="avs">
                {list.slice(0, list.length > 2 ? 1 : 2).map((o) => <Avatar key={o.item.id} name={o.item.name} size="sm" />)}
                {list.length > 2 && <span className="bud-more">+{list.length - 1}</span>}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function OccRow({ o, today, dataEnd, txById, onOpen }: { o: Occurrence; today: string; dataEnd: string; txById: Map<string, Tx>; onOpen: () => void }) {
  const tx = paidTx(o.item, o.date, txById);
  const status = tx ? `Betalt ${dayMonth(tx.date, today)} · ${kr(-tx.amount)}`
    : o.date <= dataEnd && o.date < today ? 'Ikke fundet i dine bankdata' : o.date < today ? 'Forventet – bankdata mangler' : 'Forventet';
  return (
    <button className="bud-occ" onClick={onOpen}>
      <Avatar name={o.item.name} />
      <span className="grow"><b>{o.item.name}</b><span className={`bud-muted ${tx ? 'ok' : ''}`}>{tx ? '✓ ' : ''}{status}</span></span>
      <b className="num">{o.item.variable ? 'ca. ' : ''}{kr(o.item.amount)}</b>
    </button>
  );
}

function SubList({ items, today, accountName, onOpen, stopped }: { items: BudgetItem[]; today: string; accountName: (id?: string) => string | undefined; onOpen: (i: BudgetItem) => void; stopped?: boolean }) {
  const sorted = [...items].sort((a, b) => (stopped ? 0 : (nextOccurrence(a.anchor, a.cadence, today) < nextOccurrence(b.anchor, b.cadence, today) ? -1 : 1)));
  return (
    <ul className="bud-rows">
      {sorted.map((i) => {
        const next = nextOccurrence(i.anchor, i.cadence, today);
        return (
          <li key={i.id}>
            <button className={`bud-row ${stopped ? 'muted-row' : ''}`} onClick={() => onOpen(i)}>
              <Avatar name={i.name} />
              <span className="grow">
                <b>{i.name}</b>
                <span className="bud-muted">
                  {CADENCE_LABEL[i.cadence]}
                  {accountName(i.accountId) ? ` · ${accountName(i.accountId)}` : ''}
                  {stopped && i.lastDate ? ` · sidst trukket ${dayMonth(i.lastDate, today)}` : ''}
                </span>
              </span>
              <span className={`bud-src ${i.source}`}>{SOURCE_LABEL[i.source]}</span>
              {!stopped && <span className="bud-next"><span className="bud-muted">næste</span>{dayMonth(next, today)}</span>}
              <span className="bud-right">
                <b className="num">{i.variable ? 'ca. ' : ''}{kr(i.amount)}</b>
                {i.cadence !== 'monthly' && <span className="bud-muted">{kr(perMonth(i))}/md.</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SubDialog({ item, today, onClose, onSave, onRemove, onReset }: {
  item?: BudgetItem; today: string; onClose: () => void; onSave: (s: Subscription) => void; onRemove?: () => void; onReset?: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [amount, setAmount] = useState<number | undefined>(item?.amount);
  const [cadence, setCadence] = useState<Cadence>(item?.cadence ?? 'monthly');
  const [next, setNext] = useState(item ? nextOccurrence(item.anchor, item.cadence, today) : today);
  const [accountId, setAccountId] = useState<string | undefined>(item?.accountId);
  const ok = name.trim() !== '' && !!amount && amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(next);
  const isDetected = item?.source === 'detected' || item?.source === 'edited';

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    if (!ok) return;
    const base: Subscription = { id: item && item.source !== 'detected' ? item.id : uid('sub'), name: name.trim(), amount: Math.abs(amount!), cadence, anchor: next, ...(accountId ? { accountId } : {}) };
    onSave(item?.key ? { ...base, key: item.key } : { ...base, match: subName(name) });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <form className="card modal bud-dialog" role="dialog" aria-modal aria-label={item ? `Ret ${item.name}` : 'Tilføj abonnement'}
        onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
        <div className="bud-dialog-head">
          {item && <Avatar name={name || item.name} size="lg" />}
          <h2 className="grow">{item ? (item.source === 'detected' ? 'Er det rigtigt?' : `Ret ${item.name}`) : 'Tilføj abonnement'}</h2>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Luk">✕</button>
        </div>
        {item?.source === 'detected' && (
          <p className="small ink2" style={{ marginTop: -4 }}>
            Finstate fandt dette træk {item.txIds.length} gange{item.lastDate ? ` – senest ${dateDa(item.lastDate)}` : ''}. Ret det, hvis noget er forkert – eller skjul det, hvis det ikke er et abonnement.
          </p>
        )}
        <div className="bud-form">
          <label>Navn<input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="fx Netflix" autoFocus={!item} /></label>
          <label>Beløb pr. træk<AmountInput value={amount} onCommit={setAmount} onLive={setAmount} placeholder="0,00" ariaLabel="Beløb" /></label>
          <label>Hvor ofte
            <select value={cadence} onChange={(ev) => setCadence(ev.target.value as Cadence)}>
              {CADENCES.map((c) => <option key={c} value={c}>{CADENCE_LABEL[c]}</option>)}
            </select>
          </label>
          <label>Næste træk<input type="date" value={next} onChange={(ev) => setNext(ev.target.value)} /></label>
          <label className="wide"><span>Konto <span className="muted">(valgfri)</span></span><AccountSelect value={accountId} onChange={setAccountId} filter={(a) => a.kind === 'bank'} placeholder="— ingen bestemt konto —" /></label>
        </div>
        {amount && amount > 0 && CADENCE_MONTHS[cadence] > 1 ? <p className="small ink2">Svarer til {kr(Math.round(amount / CADENCE_MONTHS[cadence]))} om måneden.</p> : null}
        {!isDetected && <p className="small muted">Finstate markerer trækket som betalt, når en transaktion med navnet dukker op i dine bankdata.</p>}
        <div className="row" style={{ marginTop: 12 }}>
          {onRemove && <button type="button" className="btn danger" onClick={onRemove}>{isDetected ? 'Ikke et abonnement – skjul' : 'Slet'}</button>}
          {onReset && <button type="button" className="btn ghost" onClick={onReset}>Brug Finstates forslag</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>Annullér</button>
          <button type="submit" className="btn bud-primary" disabled={!ok}>{item?.source === 'detected' ? 'Gem rettelse' : 'Gem'}</button>
        </div>
      </form>
    </div>
  );
}
