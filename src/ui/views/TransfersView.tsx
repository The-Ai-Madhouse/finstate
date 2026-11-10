import { clsOfLine } from '../../domain/classify';
import { NoPeriod } from '../components/PeriodPrompt';
import { useEffect, useRef, useState } from 'react';
import { inPeriod } from '../../domain/engine';
import { dateShort, kr } from '../../domain/format';
import type { Account, Classification, Period, Tx } from '../../domain/types';
import { textMatches } from '../../domain/txfilter';
import { transitName } from '../../domain/ledger';
import { transferInfo } from '../../domain/transfers';
import { dayDiff } from '../../domain/util';
import { pairTxs, setManual, unpairTxs, useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { AccountSelect, ClassEditor, Empty, InfoBox, Money, SearchCombo, isComplete } from '../components/common';
import { SettleOverview } from '../components/SettlePanel';

export function TransfersView() {
  const period = usePeriod();
  if (!period) return <NoPeriod />;
  return (
    <div className="stack">
      <h1>Overførsler</h1>
      <Internal />
      <SettleOverview />
    </div>
  );
}

type Status = 'missing' | 'paired' | 'transit' | 'direct' | 'all';
type Item =
  | { kind: 'pair'; key: string; out: Tx; inn: Tx; manual: boolean }
  /** Modposten ligger i en anden periode: i denne periode er pengene undervejs (eller kom fra forrige periode). */
  | { kind: 'transit'; key: string; t: Tx; partner: Tx; target?: Account }
  | { kind: 'missing'; key: string; t: Tx; target?: Account }
  | { kind: 'direct'; key: string; t: Tx; target?: Account; name: string; transit?: boolean };

/**
 * Interne overførsler som "fra → til": parrede vises som ét par, så man tydeligt ser, hvad der hører sammen.
 * Søg, filtrér på konto og status, par selv, ophæv en parring eller ret en overførsel direkte.
 */
function Internal() {
  const e = useEngine();
  const period = usePeriod()!;
  const { data } = e;
  const acc = (id?: string) => data.accounts.find((a) => a.id === id);
  const isInternal = (t: Tx) => e.resolved.get(t.id)!.lines.some((l) => l.type === 'internal');
  const internal = data.txs.filter((t) => inPeriod(t, period) && t.date > data.settings.bookStart && isInternal(t));
  const st = e.statement(period);
  const transitRows = st.rows.filter((r) => r.kind === 'transit' && r.close !== 0);

  // Byg listen: ét element pr. par (uanset hvilken side der ligger i perioden), ellers pr. transaktion.
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const t of internal) {
    if (seen.has(t.id)) continue;
    const info = transferInfo(data, e.resolved, e.txById, t, period)!;
    const { partner: pair, target } = info;
    if (info.kind === 'transit') {
      items.push({ kind: 'transit', key: t.id, t, partner: pair!, target });
    } else if (info.kind === 'pair') {
      seen.add(pair!.id);
      const [out, inn] = t.amount < 0 ? [t, pair!] : [pair!, t];
      items.push({ kind: 'pair', key: `${out.id}|${inn.id}`, out, inn, manual: t.pairWith === pair!.id });
    } else if (info.kind === 'direct') {
      items.push({ kind: 'direct', key: t.id, t, target, name: info.transitRef ? transitName(data, info.transitRef) : target!.name, transit: !!info.transitRef });
    } else items.push({ kind: 'missing', key: t.id, t, target });
  }
  const count = { missing: 0, paired: 0, transit: 0, direct: 0, all: items.length };
  for (const i of items) count[i.kind === 'pair' ? 'paired' : i.kind]++;

  const [status, setStatus] = useState<Status>(() => (count.missing ? 'missing' : 'all'));
  const [q, setQ] = useState('');
  const [accountId, setAccountId] = useState<string>();
  const [editing, setEditing] = useState<string>();
  // Kommer man fra Aktiver & passiver: vis én overførsel eller alle for en post.
  const [onlyTx, setOnlyTx] = useState<string>();
  const focus = useStore((st) => st.transferFocus);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    setFolded(false);
    setStatus('all');
    setQ('');
    setAccountId(focus.txId ? undefined : focus.accountId);
    setOnlyTx(focus.txId);
    useStore.getState().clearTransferFocus();
    setTimeout(() => cardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  }, [focus]);
  // Listen kan fylde meget – den kan foldes sammen (huskes i browseren).
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem('finstate:ui:xfer-folded') === '1'; } catch { return false; } });
  const toggleFold = () => setFolded((f) => { try { localStorage.setItem('finstate:ui:xfer-folded', f ? '0' : '1'); } catch { /* ignore */ } return !f; });
  const txsOf = (i: Item) => (i.kind === 'pair' ? [i.out, i.inn] : [i.t]);
  const shown = items
    .filter((i) => !onlyTx || txsOf(i).some((t) => t.id === onlyTx) || (i.kind === 'transit' && i.partner.id === onlyTx))
    .filter((i) => status === 'all' || (status === 'paired' ? i.kind === 'pair' : i.kind === status))
    .filter((i) => !accountId || txsOf(i).some((t) => t.accountId === accountId) || (i.kind !== 'pair' && i.target?.id === accountId))
    .filter((i) => !q.trim() || txsOf(i).some((t) => textMatches(t, q)) || (i.kind !== 'pair' && !!i.target && i.target.name.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => (txsOf(a)[0].date < txsOf(b)[0].date ? -1 : 1));

  const side = (t: Tx) => (
    <div className="xfer-side">
      <div><b>{acc(t.accountId)?.name}</b> <span className="muted small">{dateShort(t.date)}</span></div>
      <div className="small ink2 ellipsis" title={t.text}>{t.text}</div>
    </div>
  );
  const expected = (name: string | undefined, note: string) => (
    <div className="xfer-side expected">
      <div><b>{name ?? 'Ukendt konto'}</b></div>
      <div className="small muted">{note}</div>
    </div>
  );
  const SEG: { id: Status; label: string; tip: string }[] = [
    { id: 'missing', label: `Mangler modpost (${count.missing})`, tip: 'Overførsler mellem dine bankkonti, hvor den anden side ikke er fundet' },
    { id: 'paired', label: `Parret (${count.paired})`, tip: 'Begge sider fundet – ud på den ene konto, ind på den anden' },
    ...(count.transit ? [{ id: 'transit' as Status, label: `Undervejs (${count.transit})`, tip: 'Modposten ligger i en anden periode' }] : []),
    { id: 'direct', label: `Direkte til post (${count.direct})`, tip: 'Til en post, du ikke importerer (depot, lån, en person) – kun én side, intet at parre' },
    { id: 'all', label: `Alle (${count.all})`, tip: 'Alle interne overførsler i perioden' },
  ];

  return (
    <div className="card" ref={cardRef}>
      <div className="card-head">
        <button className="fold-head grow" onClick={toggleFold} aria-expanded={!folded}>
          <span className={`caret ${folded ? '' : 'open'}`} aria-hidden>›</span>
          <h2>Interne overførsler</h2>
          {folded && <span className="small muted">{count.paired} parret · {count.direct} direkte{count.transit ? ` · ${count.transit} undervejs` : ''}{count.missing ? '' : ' · alle har en modpost'}</span>}
        </button>
        {folded && count.missing > 0 && <span className="chip review">{count.missing} mangler modpost</span>}
        {transitRows.map((r) => (
          <span key={r.ref} className="chip" title={`Penge undervejs ved periodens slutning (primo ${kr(r.open)})`}>{r.label}: {kr(r.close)}</span>
        ))}
      </div>
      {!folded && <>
      <InfoBox label="Parret, direkte, undervejs – hvad er forskellen?">
        <dl className="xfer-legend">
          <dt><span className="chip user">⇄ Parret</span></dt>
          <dd>Overførsel mellem <b>to bankkonti, du importerer</b>. Den står derfor i begge kontis udtog – ud på den ene, ind på den anden – og de to sider skal findes og sættes sammen.
            Det sker automatisk, når beløbet passer og datoerne ligger tæt; ellers trykker du "Par".</dd>
          <dt><span className="chip">Direkte</span></dt>
          <dd>Overførsel til en <b>post, du ikke importerer</b> – fx et depot, et lån eller "Jonas skylder mig". Der er kun én side (din bankkonto), så der er intet at parre: beløbet bogføres direkte på posten.</dd>
          <dt><span className="chip review">Mangler modpost</span></dt>
          <dd>Den ene side af en overførsel mellem dine bankkonti er fundet, men ikke den anden. Find den, eller ret transaktionen, hvis den ikke er en intern overførsel.</dd>
          <dt><span className="chip">Undervejs</span></dt>
          <dd>Modposten ligger i en anden periode (fx sendt 31.12, landet 2.1). I denne periode står beløbet som <b>penge undervejs</b> til den konto, hvor pengene lander.</dd>
        </dl>
      </InfoBox>
      <div className="row xfer-filters">
        <div className="seg" role="radiogroup" aria-label="Status">
          {SEG.map((x) => <button key={x.id} role="radio" aria-checked={status === x.id} title={x.tip} className={status === x.id ? 'on plain' : ''} onClick={() => setStatus(x.id)}>{x.label}</button>)}
        </div>
        <div className="search-wrap grow">
          <input className="search-input sm" placeholder="Søg i tekst, konto eller beløb…" value={q} onChange={(ev) => setQ(ev.target.value)} aria-label="Søg i interne overførsler" />
          {q && <button className="search-clear" onClick={() => setQ('')} aria-label="Ryd søgning">✕</button>}
        </div>
        <AccountSelect className="sm" value={accountId} onChange={setAccountId} placeholder="Alle konti" />
        {(q || accountId) && <button className="btn sm ghost" onClick={() => { setQ(''); setAccountId(undefined); }}>Nulstil</button>}
      </div>
      {onlyTx && (
        <div className="banner info" style={{ marginBottom: 8 }}>
          Viser den overførsel, du kom fra. <span className="spacer" /><button className="btn sm" onClick={() => setOnlyTx(undefined)}>Vis alle overførsler</button>
        </div>
      )}

      {!shown.length ? (
        <Empty>{!items.length ? 'Ingen interne overførsler i perioden.' : status === 'missing' && !q && !accountId ? 'Alle interne overførsler har en modpost. 🎉' : 'Ingen overførsler matcher.'}</Empty>
      ) : (
        <div className="xfer-list">
          <div className="xfer-row xfer-headrow small muted"><span>Fra</span><span /><span>Til</span><span className="num">Beløb</span><span>Status</span><span /></div>
          {shown.map((i) => {
            const amount = i.kind === 'pair' ? i.inn.amount : Math.abs(i.t.amount);
            const out = i.kind === 'pair' || i.t.amount < 0;
            const t = i.kind === 'pair' ? undefined : i.t;
            return (
              <div key={i.key} className={`xfer-item ${i.kind} ${editing === i.key ? 'editing' : ''}`}>
                <div className="xfer-row">
                  {i.kind === 'pair' ? side(i.out) : out ? side(t!)
                    : i.kind === 'transit' ? expected(acc(i.partner.accountId)?.name, `sendt ${dateShort(i.partner.date)} – i forrige periode`)
                    : expected(i.kind === 'direct' ? i.name : i.target?.name, i.kind === 'direct' ? (i.transit ? 'fra forrige periode' : 'direkte') : 'venter på modpost')}
                  <span className="xfer-arrow" aria-hidden>→</span>
                  {i.kind === 'pair' ? side(i.inn) : !out ? side(t!)
                    : i.kind === 'transit' ? expected(acc(i.partner.accountId)?.name, `lander ${dateShort(i.partner.date)} – i næste periode`)
                    : i.kind === 'direct' ? expected(i.name, i.transit ? 'trækkes fra pengene undervejs' : 'bogføres direkte på posten') : expected(i.target?.name, 'pengene forventes at lande her')}
                  <span className="num"><Money v={amount} decimals /></span>
                  <span>
                    {i.kind === 'pair' ? <span className="chip user" title={i.manual ? 'Parret af dig' : 'Parret automatisk (samme beløb, tæt på hinanden)'}>⇄ Parret{i.manual ? '' : ' auto'}</span>
                      : i.kind === 'direct' ? <span className="chip" title={i.transit ? 'Bogført mod penge undervejs fra forrige periode' : undefined}>{i.transit ? 'Fra undervejs' : 'Direkte'}</span>
                      : i.kind === 'transit' ? <span className="chip" title="Modposten ligger i en anden periode – i denne periode står beløbet som penge undervejs">{out ? 'Undervejs' : 'Fra forrige periode'}</span>
                      : <span className="chip review">Mangler modpost</span>}
                    {i.kind === 'pair' && Math.abs(dayDiff(i.out.date, i.inn.date)) > 0 && <span className="small muted"> {Math.abs(dayDiff(i.out.date, i.inn.date))} dage</span>}
                  </span>
                  <span className="row xfer-actions">
                    {i.kind === 'pair' && <button className="btn sm ghost" title="De to hører ikke sammen" onClick={() => unpairTxs(i.out.id, i.inn.id)}>Ophæv</button>}
                    {i.kind === 'transit' && <button className="btn sm ghost" title="De to hører ikke sammen" onClick={() => unpairTxs(i.t.id, i.partner.id)}>Ophæv</button>}
                    <button className={`btn sm ${editing === i.key ? '' : 'ghost'}`} onClick={() => setEditing(editing === i.key ? undefined : i.key)}>{editing === i.key ? 'Luk' : 'Ret'}</button>
                  </span>
                </div>
                {i.kind === 'missing' && <PairPicker t={i.t} period={period} />}
                {editing === i.key && (
                  <div className="xfer-edit">
                    {txsOf(i).map((x) => <TxEdit key={x.id} t={x} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </>}
    </div>
  );
}

/** Mangler modpost: forslag med samme beløb – eller søg selv blandt de andre kontis transaktioner. */
function PairPicker({ t, period }: { t: Tx; period: Period }) {
  const e = useEngine();
  const { data } = e;
  const acc = (id?: string) => data.accounts.find((a) => a.id === id)?.name ?? '';
  const pool = data.txs
    // Kun transaktioner i samme financial statement.
    .filter((o) => inPeriod(o, period) && o.accountId !== t.accountId && Math.sign(o.amount) === -Math.sign(t.amount) && Math.abs(dayDiff(t.date, o.date)) <= 60 && !e.resolved.get(o.id)!.pairId)
    .sort((a, b) => (Math.abs(a.amount) === Math.abs(t.amount) ? 0 : 1) - (Math.abs(b.amount) === Math.abs(t.amount) ? 0 : 1) || Math.abs(dayDiff(t.date, a.date)) - Math.abs(dayDiff(t.date, b.date)));
  const exact = pool.filter((o) => o.amount === -t.amount).slice(0, 2);
  const options = pool.slice(0, 300).map((o) => ({ id: o.id, label: `${dateShort(o.date)} · ${acc(o.accountId)} · ${o.text}`, hint: `${kr(Math.abs(o.amount))}${o.amount !== -t.amount ? ' (andet beløb)' : ''}` }));
  return (
    <div className="xfer-pick row small">
      {exact.map((c) => (
        <span key={c.id} className="row" style={{ gap: 6 }}>
          <span className="ink2">Forslag: {acc(c.accountId)} {dateShort(c.date)} "{c.text}"</span>
          <button className="btn sm primary" onClick={() => pairTxs(t.id, c.id)}>Par</button>
        </span>
      ))}
      <SearchCombo className="sm" options={options} value={undefined} placeholder={exact.length ? 'Eller find en anden modpost…' : 'Find modposten…'} searchPlaceholder="Søg dato, konto eller tekst…"
        ariaLabel="Find modpost" emptyText="Ingen transaktion matcher" onChange={(id) => id && pairTxs(t.id, id)} />
    </div>
  );
}

/** Ret én transaktion direkte herfra (fx hvis den slet ikke er en intern overførsel). */
function TxEdit({ t }: { t: Tx }) {
  const e = useEngine();
  const r = e.resolved.get(t.id)!;
  const [cls, setCls] = useState<Classification>(() => clsOfLine(r.lines[0]));
  const acc = e.data.accounts.find((a) => a.id === t.accountId)?.name;
  return (
    <div className="xfer-edit-line">
      <div className="small"><b>{acc}</b> {dateShort(t.date)} · <span className="ink2">{t.text}</span> · <Money v={t.amount} decimals colored /></div>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <ClassEditor value={cls} onChange={setCls} amount={t.amount} accountId={t.accountId} txId={t.id} compact onCommit={(c) => setManual([t.id], c)} />
        <button className="btn sm primary" disabled={!isComplete(cls)} onClick={() => setManual([t.id], cls)}>Gem</button>
        <button className="btn sm ghost" title="Åbn i Kategorisér" onClick={() => useStore.getState().showTx(t.id)}>Vis →</button>
      </div>
    </div>
  );
}
