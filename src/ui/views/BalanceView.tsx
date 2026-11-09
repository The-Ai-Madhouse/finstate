import { NoPeriod } from '../components/PeriodPrompt';
import { Fragment, useState } from 'react';
import { KIND_HINT, KIND_LABEL, NO_TYPE, noteFor, suggestCategory, switchKind, typeName, withAccountInPeriods } from '../../domain/accountTypes';
import { kr } from '../../domain/format';
import type { BsRow } from '../../domain/ledger';
import type { Account, Period, Valuation } from '../../domain/types';
import { addDays, uid } from '../../domain/util';
import { deleteAccount, deleteImpact, moveAccount, useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { AccountNote, AmountInput, CategoryCombo, KindSelect, Money, ResultParts, SearchCombo, TypeSelect, InfoBox } from '../components/common';
import { valuationResultInPeriod } from '../../domain/ledger';
import { BalanceSourcesDialog } from '../components/SourcesDialog';
import { SettleToggle } from '../components/SettlePanel';

export function BalanceView() {
  const period = usePeriod();
  return (
    <div className="stack">
      <h1>Aktiver & passiver</h1>
      {period ? <BalanceSheet period={period} /> : <NoPeriod title="Vælg en periode for at se balancen" />}
      <Opening />
    </div>
  );
}

const SIDE_LABEL = { asset: 'Aktiver', liability: 'Passiver' } as const;

type SrcReq = { ref: string; label: string; side: 'asset' | 'liability'; view: 'primo' | 'period' };
type ShowSources = (s: SrcReq) => void;

/** Klikbart beløb i balancen → "Hvad består posten af?" */
function SrcAmount({ v, signed, colored, onOpen }: { v: number; signed?: boolean; colored?: boolean; onOpen: () => void }) {
  return (
    <button className="amount-link" title="Se hvad beløbet består af" onClick={(ev) => { ev.stopPropagation(); onOpen(); }}>
      <Money precise v={v} signed={signed} colored={colored} />
    </button>
  );
}

/** Den post der trækkes lige nu (kun inden for samme side). */
let dragging: { id: string; side: Account['side'] } | undefined;

/** Hele balancen ét sted: aktiver og passiver, redigerbare på stedet. */
function BalanceSheet({ period }: { period: Period }) {
  const e = useEngine();
  const s = e.statement(period);
  const setView = useStore((st) => st.setView);
  const [open, setOpen] = useState<string>();
  // Netop oprettet post: markøren skal stå i det felt, der skal udfyldes.
  const [justAdded, setJustAdded] = useState<string>();
  const [sources, setSources] = useState<SrcReq>();
  // Periodens poster (og poster uden for listen, der har en saldo) – placeret efter fortegn: positiv = aktiv, negativ = passiv.
  const accById = new Map(e.data.accounts.map((a) => [`acc:${a.id}`, a]));
  const sign = (sd: 'asset' | 'liability') => (sd === 'asset' ? 1 : -1);

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="grow">Balance {period.name}</h2>
        <span className="small muted">Primo = {addDays(period.start, -1)} · Ultimo = {period.end}</span>
      </div>
      <InfoBox>
        Alt du ejer og skylder. Bankkonti følger dine importerede transaktioner; andre poster følger enten dine overførsler, eller du skriver værdien selv.
        En post med positiv saldo står under aktiver, en med negativ under passiver. Ændringer, der ikke skyldes dine egne overførsler, bliver til afkast, renter m.m. – klik på en række for detaljer.
      </InfoBox>
      <table className="bs">
        {(['asset', 'liability'] as const).map((sd) => {
          const accRows = s.rows.filter((r) => r.side === sd && accById.has(r.ref));
          const autoRows = s.rows.filter((r) => r.side === sd && (r.kind === 'cp' || r.kind === 'transit'));
          const total = sd === 'asset' ? [s.assetsOpen, s.assetsClose] : [s.liabOpen, s.liabClose];
          return (
            <tbody key={sd}>
              <tr className="bs-head">
                <th>{SIDE_LABEL[sd]}</th><th>Type</th><th className="num">Primo</th><th className="num">Ultimo</th><th className="num">Ændring</th><th />
              </tr>
              {accRows.map((row) => {
                const a = accById.get(row.ref)!;
                return (
                  <AccountRow key={a.id} acc={a} row={row} period={period} expanded={open === a.id} justAdded={justAdded === a.id} onToggle={() => setOpen(open === a.id ? undefined : a.id)} onSources={setSources} />
                );
              })}
              {autoRows.map((r) => (
                <tr key={r.ref}>
                  <td>{r.label}</td>
                  <td><span className="chip">{r.kind === 'cp' ? (r.side === 'asset' ? 'Tilgodehavende · udlæg' : 'Gæld · udlæg') : 'Penge undervejs'}</span></td>
                  <td className="num"><SrcAmount v={r.open * sign(sd)} onOpen={() => setSources({ ref: r.ref, label: r.label, side: sd, view: 'primo' })} /></td>
                  <td className="num"><SrcAmount v={r.close * sign(sd)} onOpen={() => setSources({ ref: r.ref, label: r.label, side: sd, view: 'period' })} /></td>
                  <td className="num ink2"><SrcAmount v={(r.close - r.open) * sign(sd)} signed onOpen={() => setSources({ ref: r.ref, label: r.label, side: sd, view: 'period' })} /></td>
                  <td className="num"><button className="btn sm ghost" onClick={() => setView('transfers')}>{r.kind === 'cp' ? 'Se udlæg →' : 'Se overførsler →'}</button></td>
                </tr>
              ))}
              <AddRow side={sd} period={period} onAdded={(id) => { setOpen(id); setJustAdded(id); }} />
              <tr className="sum">
                <td colSpan={2}>{SIDE_LABEL[sd]} i alt</td>
                <td className="num"><Money precise v={total[0]} /></td>
                <td className="num"><Money precise v={total[1]} /></td>
                <td className="num"><Money precise v={total[1] - total[0]} signed /></td>
                <td />
              </tr>
              <tr className="bs-gap"><td colSpan={6} /></tr>
            </tbody>
          );
        })}
        <tbody>
          <tr className="sum equity">
            <td colSpan={2}>Egenkapital (aktiver − passiver)</td>
            <td className="num"><Money precise v={s.equityOpen} /></td>
            <td className="num"><Money precise v={s.equityClose} /></td>
            <td className="num"><Money precise v={s.equityClose - s.equityOpen} signed colored /></td>
            <td />
          </tr>
        </tbody>
      </table>
      {sources && <BalanceSourcesDialog refKey={sources.ref} label={sources.label} side={sources.side} view={sources.view} period={period} onClose={() => setSources(undefined)} />}
    </div>
  );
}

function useValuationActions(acc: Account) {
  const update = useStore((s) => s.update);
  const liab = acc.side === 'liability';
  const toStored = (v: number) => (liab ? -Math.abs(v) : v);
  return {
    upsert: (date: string, shown: number | undefined) =>
      update((d) => {
        const ex = d.valuations.find((v) => v.accountId === acc.id && v.date === date);
        if (shown === undefined) return { ...d, valuations: d.valuations.filter((v) => v !== ex) };
        if (ex) return { ...d, valuations: d.valuations.map((v) => (v === ex ? { ...v, value: toStored(shown) } : v)) };
        return { ...d, valuations: [...d.valuations, { id: uid('val'), accountId: acc.id, date, value: toStored(shown), adjustments: [] }] };
      }),
    patchValuation: (id: string, fn: (v: Valuation) => Valuation) =>
      update((d) => ({ ...d, valuations: d.valuations.map((v) => (v.id === id ? fn(v) : v)) })),
    patchAccount: (patch: Partial<Account>) =>
      update((d) => {
        const sideFlip = patch.side && patch.side !== acc.side;
        return {
          ...d,
          accounts: d.accounts.map((a) => (a.id === acc.id ? { ...a, ...patch } : a)),
          // Skifter posten side (aktiv ↔ passiv), vendes de gemte værdier også.
          valuations: sideFlip ? d.valuations.map((v) => (v.accountId === acc.id ? { ...v, value: -v.value } : v)) : d.valuations,
        };
      }),
  };
}

function AccountRow({ acc, row, period, expanded, onToggle, onSources, justAdded }: { acc: Account; row: BsRow; period: Period; expanded: boolean; justAdded?: boolean; onToggle: () => void; onSources: ShowSources }) {
  const openSources = (view: 'primo' | 'period' = 'period') => onSources({ ref: `acc:${acc.id}`, label: acc.name, side: row.side, view });
  const [draggable, setDraggable] = useState(false);
  const [over, setOver] = useState(false);
  const e = useEngine();
  const sign = row.side === 'asset' ? 1 : -1;
  // Værdier tastes med postens naturlige fortegn (gæld som positivt tal).
  const inSign = acc.side === 'asset' ? 1 : -1;
  const primoDate = addDays(period.start, -1);
  const { upsert } = useValuationActions(acc);
  const vals = e.data.valuations.filter((v) => v.accountId === acc.id);
  const vPrimo = vals.find((v) => v.date === primoDate);
  const vUltimo = vals.find((v) => v.date === period.end);
  const manual = acc.kind === 'valuation';
  const missing = manual && !vUltimo;
  const hasTx = acc.kind === 'bank' && e.data.txs.some((t) => t.accountId === acc.id);
  return (
    <Fragment>
      <tr className={`click ${expanded ? 'sel' : ''} ${over ? 'drop-over' : ''}`}
        onClick={(ev) => { if (!(ev.target as HTMLElement).closest('input,button,select,.drag-handle')) onToggle(); }}
        draggable={draggable}
        onDragStart={(ev) => { dragging = { id: acc.id, side: row.side }; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', acc.id); }}
        onDragEnd={() => { dragging = undefined; setDraggable(false); }}
        onDragOver={(ev) => { if (dragging && dragging.side === row.side && dragging.id !== acc.id) { ev.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(ev) => { ev.preventDefault(); setOver(false); if (dragging) moveAccount(dragging.id, { before: acc.id }); dragging = undefined; }}>
        <td>
          <span className="drag-handle" title="Træk for at flytte" aria-hidden onMouseDown={() => setDraggable(true)} onMouseUp={() => setDraggable(false)}>⋮⋮</span>
          <span className="caret">{expanded ? '▾' : '▸'}</span> {acc.name} {noteFor(acc, period.id) ? <div style={{ paddingLeft: 16 }}><AccountNote account={acc} /></div> : <AccountNote account={acc} />}</td>
        <td><span className={`chip ${acc.typeId ? '' : 'muted'}`} title={`${KIND_LABEL[acc.kind]}. ${KIND_HINT[acc.kind]}`}>{typeName(e.data.accountTypes, acc)}</span></td>
        {manual ? (
          <>
            <td className="num" style={{ width: 150 }}>
              <AmountInput className="sm" value={vPrimo ? vPrimo.value * inSign : undefined} placeholder={kr(row.open * inSign)} onCommit={(v) => upsert(primoDate, v)} ariaLabel={`${acc.name} primo`} />
            </td>
            <td className="num" style={{ width: 150 }}>
              <AmountInput className={`sm ${missing ? 'missing' : ''}`} value={vUltimo ? vUltimo.value * inSign : undefined} placeholder="angiv værdi" onCommit={(v) => upsert(period.end, v)} ariaLabel={`${acc.name} ultimo`} autoFocus={justAdded} />
            </td>
          </>
        ) : (
          <>
            <td className="num"><SrcAmount v={row.open * sign} onOpen={() => openSources('primo')} /></td>
            <td className="num"><SrcAmount v={row.close * sign} onOpen={() => openSources()} />{acc.kind === 'bank' && !hasTx && <div className="small neg">ingen import</div>}</td>
          </>
        )}
        <td className="num ink2"><SrcAmount v={(row.close - row.open) * sign} signed onOpen={() => openSources()} />{manual && <ResultParts parts={valuationResultInPeriod(e.data, e.ledger, period, acc.id)} categories={e.data.categories} />}</td>
        <td className="num"><button className="btn sm ghost" onClick={onToggle}>{expanded ? 'Luk' : 'Detaljer'}</button></td>
      </tr>
      {expanded && (
        <tr className="sel"><td colSpan={6}><AccountDetails acc={acc} period={period} focusOpening={justAdded && acc.kind === 'tracked'} /></td></tr>
      )}
    </Fragment>
  );
}

function AccountDetails({ acc, period, focusOpening }: { acc: Account; period: Period; focusOpening?: boolean }) {
  const [newAdj, setNewAdj] = useState<string>();
  const e = useEngine();
  const { data } = e;
  const setView = useStore((s) => s.setView);
  const { patchAccount, patchValuation } = useValuationActions(acc);
  const update = useStore((s) => s.update);
  const [aliases, setAliases] = useState(acc.aliases.join(', '));
  const sign = acc.side === 'asset' ? 1 : -1;
  const vals = data.valuations.filter((v) => v.accountId === acc.id).sort((a, b) => (a.date < b.date ? -1 : 1));
  const vUltimo = vals.find((v) => v.date === period.end);
  const prev = vUltimo ? vals.filter((v) => v.date < vUltimo.date).pop() : undefined;
  const moved = prev && vUltimo
    ? e.ledger.postings.filter((p) => p.ref === `acc:${acc.id}` && p.txId && p.date > prev.date && p.date <= vUltimo.date).reduce((s, p) => s + p.amount, 0)
    : 0;
  const residual = prev && vUltimo ? vUltimo.value - prev.value - moved : undefined;
  const adjSum = vUltimo?.adjustments.reduce((s, a) => s + a.amount, 0) ?? 0;
  const hasTx = data.txs.some((t) => t.accountId === acc.id);
  const row = e.statement(period).rows.find((r) => r.ref === `acc:${acc.id}`);
  const isZero = !row?.open && !row?.close;
  const note = noteFor(acc, period.id) ?? '';

  const setKind = (kind: Account['kind']) => update((d) => switchKind(d, acc.id, kind));
  const setNote = (v: string) =>
    update((d) => ({ ...d, accounts: d.accounts.map((a) => {
      if (a.id !== acc.id) return a;
      const notes = { ...a.notes };
      if (v) notes[period.id] = v; else delete notes[period.id];
      return { ...a, notes };
    }) }));
  const removeFromPeriod = () =>
    update((d) => ({ ...d, periods: d.periods.map((p) => (p.id === period.id ? { ...p, accountIds: (p.accountIds ?? d.accounts.filter((a) => !a.archived).map((a) => a.id)).filter((id) => id !== acc.id) } : p)) }));

  return (
    <div className="col" style={{ gap: 12, padding: '6px 0 10px 18px' }}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field">Navn<input value={acc.name} onChange={(ev) => patchAccount({ name: ev.target.value })} /></label>
        <label className="field">Type
          <TypeSelect value={acc.typeId} onChange={(typeId) => patchAccount({ typeId })} />
        </label>
        <label className="field grow" title="Navne kontoen har i andre kontis posteringstekster, fx 'Min opsparing'. Bruges til at genkende overførsler.">
          Genkendes i overførselstekster som (komma-separeret)
          <input value={aliases} onChange={(ev) => setAliases(ev.target.value)} onBlur={() => patchAccount({ aliases: aliases.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </label>
      </div>
      <label className="field">Kommentar for {period.name}
        <textarea key={`${period.id}:${note}`} rows={2} defaultValue={note} placeholder="Fx rente 4 %, aftale om tilbagebetaling, hvor værdien kommer fra …"
          onBlur={(ev) => setNote(ev.target.value.trim())} />
      </label>

      {!hasTx && (
        <div className="row small">
          <span className="ink2">Saldo:</span>
          <div className="seg" role="radiogroup" aria-label="Saldo">
            {(acc.kind === 'bank' ? (['bank', 'tracked', 'valuation'] as const) : (['tracked', 'valuation'] as const)).map((k) => (
              <button key={k} className={acc.kind === k ? 'on plain' : ''} role="radio" aria-checked={acc.kind === k} title={KIND_HINT[k]} onClick={() => acc.kind !== k && setKind(k)}>{k === 'bank' ? 'Bankkonto' : KIND_LABEL[k]}</button>
            ))}
          </div>
          {acc.kind === 'valuation' && <span className="muted">Skriv værdien pr. periodens start og slut i rækken ovenfor.</span>}
        </div>
      )}
      {acc.kind === 'tracked' ? (
        <div className="col" style={{ gap: 10 }}>
          <TrackedOpening acc={acc} autoFocus={focusOpening} />
          <SettleToggle acc={acc} />
        </div>
      ) : acc.kind === 'bank' ? (
        <div className="row small">
          <span className="ink2">Saldo følger importerede transaktioner.</span>
          <button className="btn sm" onClick={() => setView('import')}>Importér transaktioner →</button>
          <span className="spacer" />
          <span className="ink2">Åbningssaldo (kun hvis den ikke kan udledes):</span>
          <AmountInput className="sm" value={acc.openingBalance} placeholder="automatisk" onCommit={(v) => patchAccount({ openingBalance: v })} ariaLabel="Åbningssaldo" />
        </div>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          <div className="row small">
            <span className="ink2">Uforklaret ændring bogføres som</span>
            <CategoryCombo className="sm" value={acc.defaultCategoryId} allowClear="Ukategoriseret" onChange={(c) => patchAccount({ defaultCategoryId: c })} />
            {!acc.defaultCategoryId && <span className="neg">vælg kategori, ellers står den som ukategoriseret</span>}
          </div>
          {vUltimo && prev && residual !== undefined ? (
            <table className="small" style={{ maxWidth: 640 }}>
              <tbody>
                <tr><td>Værdi {prev.date} → {vUltimo.date}</td><td className="num"><Money v={(vUltimo.value - prev.value) * sign} signed /></td></tr>
                <tr><td>Heraf dine egne overførsler (indskud/afdrag)</td><td className="num"><Money v={moved * sign} signed /></td></tr>
                {vUltimo.adjustments.map((a) => (
                  <tr key={a.id}>
                    <td><div className="row" style={{ flexWrap: 'nowrap' }}>Heraf <CategoryCombo className="sm" value={a.categoryId} onChange={(c) => c && patchValuation(vUltimo.id, (x) => ({ ...x, adjustments: x.adjustments.map((y) => (y.id === a.id ? { ...y, categoryId: c } : y)) }))} />
                      <button className="btn sm ghost" onClick={() => patchValuation(vUltimo.id, (x) => ({ ...x, adjustments: x.adjustments.filter((y) => y.id !== a.id) }))} aria-label="Fjern">✕</button></div></td>
                    <td className="num"><AmountInput className="sm" value={a.amount} autoFocus={a.id === newAdj} onCommit={(n) => patchValuation(vUltimo.id, (x) => ({ ...x, adjustments: x.adjustments.map((y) => (y.id === a.id ? { ...y, amount: n ?? 0 } : y)) }))} /></td>
                  </tr>
                ))}
                <tr className="sum"><td>Uforklaret → bogføres som {acc.defaultCategoryId ? data.categories.find((c) => c.id === acc.defaultCategoryId)?.name : 'ukategoriseret'} (effekt på egenkapital)</td><td className="num"><Money v={residual - adjSum} signed colored /></td></tr>
              </tbody>
            </table>
          ) : (
            <span className="small muted">Angiv både primo og ultimo for at se, hvad ændringen består af.</span>
          )}
          {vUltimo && prev && (
            <div>
              <button className="btn sm ghost" disabled={!data.categories.length} onClick={() => { const adjId = uid('adj'); setNewAdj(adjId); patchValuation(vUltimo.id, (x) => ({ ...x, adjustments: [...x.adjustments, { id: adjId, categoryId: data.categories.find((c) => /skat/i.test(c.name))?.id ?? acc.defaultCategoryId ?? data.categories[0].id, amount: 0 }] })); }}>
                + Specificér en del (fx skat eller gebyr)
              </button>
            </div>
          )}
        </div>
      )}

      <div className="row">
        <span className="spacer" />
        {isZero
          ? <button className="btn sm ghost" onClick={removeFromPeriod} title="Posten vises ikke længere i denne periodes balance (og kopieres ikke med til nye perioder herfra). Historikken bevares.">Fjern fra {period.name}</button>
          : <span className="small muted" title="Kun poster, der står i 0 både primo og ultimo, kan fjernes fra perioden">Har en saldo i perioden</span>}
        <DeleteAccountButton acc={acc} />
      </div>
    </div>
  );
}

function AddRow({ side, period, onAdded }: { side: 'asset' | 'liability'; period: Period; onAdded: (id: string) => void }) {
  const data = useStore((s) => s.data);
  const update = useStore((s) => s.update);
  const setView = useStore((s) => s.setView);
  const [active, setActive] = useState(false);
  const [typeId, setTypeId] = useState<string>();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'tracked' | 'valuation'>('valuation');
  // Poster, der findes, men ikke er med i denne periode (fx fjernet tidligere).
  const missing = period.accountIds ? data.accounts.filter((a) => a.side === side && !period.accountIds!.includes(a.id)) : [];
  const add = () => {
    if (!name.trim()) return;
    const id = uid('acc');
    update((d) => withAccountInPeriods({
      ...d,
      accounts: [...d.accounts, { id, name: name.trim(), kind, typeId, side, aliases: kind === 'tracked' ? [] : [name.trim()], defaultCategoryId: kind === 'valuation' ? suggestCategory(d.categories, side) : undefined }],
    }, id, period.id));
    setName('');
    setActive(false);
    onAdded(id);
  };
  const addExisting = (id: string) => {
    update((d) => withAccountInPeriods(d, id, period.id));
    onAdded(id);
  };
  if (!active) {
    return (
      <tr className="add-row"
        onDragOver={(ev) => { if (dragging?.side === side) ev.preventDefault(); }}
        onDrop={(ev) => { ev.preventDefault(); if (dragging?.side === side) moveAccount(dragging.id, { toEnd: true }); dragging = undefined; }}>
        <td colSpan={6}>
          <div className="row">
            <button className="btn sm ghost" onClick={() => setActive(true)}>+ Tilføj {side === 'asset' ? 'aktiv' : 'passiv'}</button>
            {missing.length > 0 && (
              <SearchCombo className="sm" options={missing.map((a) => ({ id: a.id, label: a.name }))} value={undefined} onChange={(id) => id && addExisting(id)}
                placeholder="Tilføj eksisterende post…" searchPlaceholder="Søg post…" ariaLabel="Tilføj eksisterende post" emptyText="Ingen post matcher" />
            )}
            {side === 'asset' && <span className="small muted">Bankkonti oprettes, når du <button className="linkish" onClick={() => setView('import')}>importerer</button> deres transaktioner.</span>}
          </div>
        </td>
      </tr>
    );
  }
  return (
    <tr className="add-row sel">
      <td colSpan={6}>
        <div className="row" onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'BUTTON') add(); if (ev.key === 'Escape') setActive(false); }}>
          <input autoFocus placeholder={side === 'asset' ? 'Navn, fx Aktiedepot' : 'Navn, fx Billån'} value={name} onChange={(ev) => setName(ev.target.value)} aria-label="Navn" />
          <TypeSelect value={typeId} onChange={setTypeId} />
          <KindSelect value={kind} onChange={setKind} />
          <button className="btn sm primary" disabled={!name.trim()} onClick={add}>Tilføj</button>
          <button className="btn sm ghost" onClick={() => setActive(false)}>Annullér</button>
          <InfoBox label="Type og saldo">
            <b>{KIND_LABEL.tracked}:</b> {KIND_HINT.tracked}<br /><b>{KIND_LABEL.valuation}:</b> {KIND_HINT.valuation}<br />
            Typen er valgfri ({NO_TYPE.toLowerCase()} er fint) – opret dine egne med "+ Ny type…".
          </InfoBox>
        </div>
      </td>
    </tr>
  );
}

function Opening() {
  const e = useEngine();
  const update = useStore((s) => s.update);
  const { data } = e;
  const { bookStart } = data.settings;
  const opening = e.ledger.postings.filter((p) => p.date === bookStart && p.ref !== 'opening');
  const firstPeriod = [...data.periods].sort((a, b) => (a.start < b.start ? -1 : 1))[0];
  const txBefore = data.txs.filter((t) => t.date <= bookStart).length;

  return (
    <div className="card">
      <h2>Åbningsbalance & bogføringsstart</h2>
      <InfoBox>
        Bogføringen starter dagen efter <b>bogføringsstart</b>. Bankkontiens åbningssaldo udledes automatisk af saldokolonnen.
        Startsaldoen for poster som "Jonas skylder mig" skriver du under postens Detaljer i balancen ovenfor; penge der var undervejs mellem konti skriver du her.
      </InfoBox>
      {firstPeriod && addDays(bookStart, 1) !== firstPeriod.start && <p className="small neg" style={{ marginBottom: 8 }}>Tip: første periode starter {firstPeriod.start} – bogføringsstart bør typisk være {addDays(firstPeriod.start, -1)}.</p>}
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field">Bogføringsstart {data.settings.bookStartSet ? '(valgt af dig)' : '(automatisk ud fra dine data)'}
          <input type="date" value={bookStart} onChange={(ev) => ev.target.value && update((d) => ({ ...d, settings: { ...d.settings, bookStart: ev.target.value, bookStartSet: true } }))} />
        </label>
        {data.settings.bookStartSet && (
          <button className="btn sm ghost" title="Lad bogføringsstart følge den første måned med data" onClick={() => update((d) => ({ ...d, settings: { ...d.settings, bookStartSet: false } }))}>Automatisk</button>
        )}
        <label className="field">Penge undervejs pr. {bookStart}
          <AmountInput value={data.settings.openingTransit} onCommit={(v) => update((d) => ({ ...d, settings: { ...d.settings, openingTransit: v ?? 0 } }))} />
        </label>
        {txBefore > 0 && <span className="small muted">{txBefore} importerede transaktioner ligger før bogføringsstart og tæller ikke med (men bruges til at finde åbningssaldo).</span>}
      </div>
        <table>
          <thead><tr><th>Åbningsposter pr. {bookStart}</th><th className="num">Beløb</th></tr></thead>
          <tbody>
            {opening.map((p, i) => {
              const a = p.ref.startsWith('acc:') ? data.accounts.find((x) => `acc:${x.id}` === p.ref) : undefined;
              return <tr key={i}><td>{a?.name ?? (p.ref === 'transit' ? 'Penge undervejs' : e.ledger.cpLabels.get(p.ref) ?? p.ref)}</td><td className="num"><Money v={p.amount} /></td></tr>;
            })}
            <tr className="sum"><td>Egenkapital primo</td><td className="num"><Money v={opening.reduce((s, p) => s + p.amount, 0)} /></td></tr>
          </tbody>
        </table>
    </div>
  );
}

/** Saldo ved bogføringsstart for en post, der ellers følger dine overførsler (fx "Jonas skylder mig"). */
function TrackedOpening({ acc, autoFocus }: { acc: Account; autoFocus?: boolean }) {
  const data = useStore((s) => s.data);
  const update = useStore((s) => s.update);
  const { bookStart } = data.settings;
  const sign = acc.side === 'asset' ? 1 : -1;
  const item = data.openItems.find((o) => o.accountId === acc.id && !o.categoryId);
  const set = (v?: number) =>
    update((d) => {
      const rest = d.openItems.filter((o) => !(o.accountId === acc.id && !o.categoryId));
      if (!v) return { ...d, openItems: rest };
      return { ...d, openItems: [...rest, { id: item?.id ?? uid('oi'), date: bookStart, counterparty: acc.name, accountId: acc.id, amount: sign * v }] };
    });
  return (
    <div className="row small">
      <span className="ink2">Saldoen følger dine overførsler til og fra posten.</span>
      <span className="spacer" />
      <span className="ink2">Saldo ved bogføringsstart ({bookStart}):</span>
      <AmountInput className="sm" value={item ? item.amount * sign : undefined} placeholder="0" onCommit={set} ariaLabel="Startsaldo" autoFocus={autoFocus} />
    </div>
  );
}

/** Slet posten – med advarsel om præcis, hvad der fjernes. */
function DeleteAccountButton({ acc }: { acc: Account }) {
  const data = useStore((s) => s.data);
  const [asking, setAsking] = useState(false);
  const imp = deleteImpact(data, acc.id);
  if (imp.importedTxs) {
    return <span className="small muted" title="Slet først kontoens transaktioner under Importér">Kan ikke slettes ({imp.importedTxs} importerede transaktioner)</span>;
  }
  if (!asking) return <button className="btn sm ghost danger" onClick={() => setAsking(true)}>Slet post</button>;
  const lines = [
    imp.valuations && `${imp.valuations} indtastede værdier`,
    imp.openItems && 'startsaldoen',
    imp.txs && `${imp.txs} transaktioner bogført til posten (de nulstilles og skal afgøres igen)`,
    imp.rules && `${imp.rules} regler der peger på posten`,
  ].filter(Boolean);
  return (
    <div className="delete-confirm inline-confirm" role="alertdialog">
      <b>Er du helt sikker på, at du vil slette "{acc.name}"?</b>
      {lines.length > 0 && <div className="small ink2">Det fjerner også: {lines.join(', ')}.</div>}
      <div className="small muted">Det kan ikke fortrydes uden backup. Vil du bare skjule den, så fjern den fra perioden (når saldoen er 0).</div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
        <button className="btn sm" autoFocus onClick={() => setAsking(false)}>Annullér</button>
        <button className="btn sm danger-solid" onClick={() => deleteAccount(acc.id)}>Ja, slet {acc.name}</button>
      </div>
    </div>
  );
}
