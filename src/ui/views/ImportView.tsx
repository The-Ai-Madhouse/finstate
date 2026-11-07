import { useState } from 'react';
import { accountHint, buildTxs, decodeBytes, guessMapping, isBrokerSheet, isCompleteMapping, parseCsv, type ParsedSheet } from '../../domain/csv';
import { suggestCategory, withAccountInPeriods } from '../../domain/accountTypes';
import { normalizeText } from '../../domain/normalize';
import { uid } from '../../domain/util';
import type { Rule } from '../../domain/types';
import { slug } from '../../domain/defaults';
import { kr } from '../../domain/format';
import { orderChain } from '../../domain/reconcile';
import type { ColumnMapping } from '../../domain/types';
import { useEngine } from '../../store/actions';
import { useStore } from '../../store/store';
import { usePeriod } from '../../store/actions';
import { NoPeriod } from '../components/PeriodPrompt';
import { importCoverage } from '../../domain/engine';
import { dateDa } from '../../domain/format';
import { AccountSelect, Empty, Money } from '../components/common';

interface Pending {
  key: string;
  fileName: string;
  sheet: ParsedSheet;
  mapping: Partial<ColumnMapping>;
  accountId?: string;
}

export function ImportView() {
  return usePeriod() ? <ImportInner /> : <NoPeriod />;
}

/** Dækker de importerede data det aktuelle financial statement – konto for konto? */
function CoverageCard() {
  const data = useStore((s) => s.data);
  const period = usePeriod()!;
  const cov = importCoverage(data, period);
  return (
    <div className="card">
      <h2>Data til {period.name}</h2>
      <p className="ink2 small" style={{ marginBottom: 10 }}>
        Til dette financial statement skal hver bankkonto have data fra {dateDa(period.start)} til {dateDa(period.end)} (gerne lidt før og efter).
      </p>
      {!cov.length ? (
        <Empty>Ingen bankkonti endnu – træk din første CSV-fil herind nedenfor, så oprettes kontoen.</Empty>
      ) : (
        <table>
          <thead><tr><th>Konto</th><th>Data fra</th><th>Data til</th><th>Dækker perioden</th></tr></thead>
          <tbody>
            {cov.map((c) => (
              <tr key={c.accountId}>
                <td>{c.name}</td>
                <td>{c.first ?? '–'}</td>
                <td>{c.last ?? '–'}</td>
                <td>
                  {c.coversStart && c.coversEnd ? <span className="chip user">✓ Ja</span>
                    : <span className="chip review">{!c.first ? 'Ingen data' : !c.coversStart ? `Mangler data før ${c.first}` : `Mangler data efter ${c.last}`}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ImportInner() {
  const data = useStore((s) => s.data);
  const [pending, setPending] = useState<Pending[]>([]);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<string>();

  const addFiles = async (files: FileList | File[]) => {
    const next: Pending[] = [];
    for (const f of Array.from(files)) {
      try {
        const sheet = parseCsv(decodeBytes(await f.arrayBuffer()));
        const mapping = { ...guessMapping(sheet), ...data.importProfiles[sheet.headerSignature] };
        const hint = accountHint(sheet, mapping)?.toLowerCase();
        const fname = f.name.toLowerCase();
        const banks = data.accounts.filter((a) => a.kind === 'bank' && !a.archived);
        const acc =
          (hint && banks.find((a) => [a.name, ...a.aliases].some((n) => n.toLowerCase() === hint))) ||
          (hint && banks.find((a) => [a.name, ...a.aliases].some((n) => n.length > 2 && hint.includes(n.toLowerCase())))) ||
          banks.find((a) => [a.name, ...a.aliases].some((n) => n.length > 2 && fname.includes(n.toLowerCase().split(' ').pop()!)));
        next.push({ key: `${f.name}-${f.size}-${Math.random()}`, fileName: f.name, sheet, mapping, accountId: acc?.id });
      } catch (e) {
        setMsg(`${f.name}: kunne ikke læses (${(e as Error).message})`);
      }
    }
    setPending((p) => [...p, ...next]);
  };

  return (
    <div className="stack">
      <h1>Importér bankdata</h1>
      <CoverageCard />
      <p className="ink2" style={{ maxWidth: 820 }}>
        Eksportér transaktioner som CSV fra netbanken for hver konto (typisk under kontoen → Eksportér). Filen læses kun her i browseren.
        Det er sikkert at importere overlappende perioder – transaktioner, der allerede findes, springes over.
      </p>
      <label
        className={`drop ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
      >
        <input type="file" accept=".csv,.txt,text/csv" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
        <b>Træk CSV-filer hertil</b> eller klik for at vælge
        <div className="small muted">Semikolon, komma eller tabulator · UTF-8, UTF-16 (fx fra en netbroker) eller Windows-1252 · danske og engelske talformater – alt genkendes automatisk</div>
      </label>
      {msg && <div className="banner info">{msg} <span className="spacer" /><button className="btn sm ghost" onClick={() => setMsg(undefined)}>Luk</button></div>}
      {pending.map((p) => (
        <PendingCard
          key={p.key}
          p={p}
          onChange={(np) => setPending((all) => all.map((x) => (x.key === p.key ? np : x)))}
          onDone={(m) => { setMsg(m); setPending((all) => all.filter((x) => x.key !== p.key)); }}
          onCancel={() => setPending((all) => all.filter((x) => x.key !== p.key))}
        />
      ))}
      <AccountsSummary />
    </div>
  );
}

const FIELDS: { k: keyof ColumnMapping; label: string; required?: boolean; help: string }[] = [
  { k: 'date', label: 'Dato', required: true, help: 'Bogføringsdato' },
  { k: 'amount', label: 'Beløb', required: true, help: 'Negativt = penge ud' },
  { k: 'balance', label: 'Saldo', help: 'Bruges til automatisk afstemning' },
  { k: 'note', label: 'Din kommentar', help: 'Gemmes som note på transaktionen' },
  { k: 'category', label: 'Bankens hovedkategori', help: 'Kun til forslag' },
  { k: 'subcategory', label: 'Bankens underkategori', help: 'Kun til forslag' },
  { k: 'accountName', label: 'Kontonavn', help: 'Vælger kontoen automatisk' },
];

function PendingCard({ p, onChange, onDone, onCancel }: { p: Pending; onChange: (p: Pending) => void; onDone: (msg: string) => void; onCancel: () => void }) {
  const data = useStore((s) => s.data);
  const update = useStore((s) => s.update);
  const broker = isBrokerSheet(p.sheet);
  const periodId = useStore((s) => s.periodId);
  // Et depotnummer er et dårligt kontonavn – foreslå "Depot" og brug nummeret som genkendelse.
  const [newName, setNewName] = useState(() => {
    const h = accountHint(p.sheet, p.mapping) ?? '';
    return broker && /^\d+$/.test(h.trim()) ? 'Depot' : h;
  });
  const [setupSecurities, setSetupSecurities] = useState(true);
  const complete = isCompleteMapping(p.mapping);
  const [showCols, setShowCols] = useState(!complete);
  const preview = complete && p.accountId ? buildTxs(p.sheet, p.mapping as ColumnMapping, p.accountId) : undefined;
  const existingById = new Map(data.txs.map((t) => [t.id, t]));
  const fresh = preview?.txs.filter((t) => !existingById.has(t.id)) ?? [];
  // Allerede importerede transaktioner, som filen kan give en kommentar.
  const noteFills = preview?.txs.filter((t) => t.note && existingById.has(t.id) && !existingById.get(t.id)!.note) ?? [];
  const chain = preview ? orderChain(preview.txs) : undefined;
  const dates = preview?.txs.map((t) => t.date).sort() ?? [];
  const hint = accountHint(p.sheet, p.mapping);
  const useBank = data.settings.useBankCategories !== false;
  const hasBankCats = p.mapping.category !== undefined || p.mapping.subcategory !== undefined;
  const colName = (i?: number) => (i === undefined ? undefined : p.sheet.header[i] || `Kolonne ${i + 1}`);

  const setCol = (k: keyof ColumnMapping, v: string) => {
    const m = { ...p.mapping };
    if (k === 'text') m.text = v === '' ? [] : [Number(v)];
    else if (v === '') delete m[k];
    else (m as Record<string, number>)[k] = Number(v);
    onChange({ ...p, mapping: m });
  };
  const colSelect = (k: keyof ColumnMapping, value: number | undefined, optional: boolean) => (
    <select className="sm" value={value ?? ''} onChange={(e) => setCol(k, e.target.value)}>
      <option value="">{optional ? '— bruges ikke —' : '— vælg —'}</option>
      {p.sheet.header.map((h, i) => <option key={i} value={i}>{h || `Kolonne ${i + 1}`}</option>)}
    </select>
  );

  const doImport = () => {
    if (!preview || !p.accountId) return;
    const notes = new Map(noteFills.map((t) => [t.id, t.note!]));
    const accountId = p.accountId;
    update((d) => {
      let next: typeof d = {
        ...d,
        txs: [...d.txs.map((t) => (notes.has(t.id) ? { ...t, note: notes.get(t.id) } : t)), ...fresh],
        importProfiles: { ...d.importProfiles, [p.sheet.headerSignature]: p.mapping as ColumnMapping },
      };
      if (broker && setupSecurities) next = setupDepot(next, accountId, periodId);
      return next;
    });
    const name = data.accounts.find((a) => a.id === p.accountId)?.name;
    const dup = preview.txs.length - fresh.length;
    onDone(
      `${p.fileName}: ${fresh.length} nye transaktioner importeret til ${name}` +
        (dup ? ` (${dup} fandtes allerede)` : '') +
        (noteFills.length ? `, ${noteFills.length} fik din kommentar tilføjet` : '') +
        '. Næste trin: Kategorisér.',
    );
  };

  const createAccount = () => {
    if (!newName.trim()) return;
    const id = `acc-${slug(newName)}-${Date.now().toString(36)}`;
    const aliases = hint ? [hint] : [];
    update((d) => withAccountInPeriods({ ...d, accounts: [...d.accounts, { id, name: newName.trim(), kind: 'bank', side: 'asset', aliases }] }, id, periodId));
    onChange({ ...p, accountId: id });
  };

  const detected = [
    ['Dato', colName(p.mapping.date)],
    ['Tekst', p.mapping.text?.map(colName).join(' + ')],
    ['Beløb', colName(p.mapping.amount)],
    ['Saldo', colName(p.mapping.balance)],
    ['Kommentar', colName(p.mapping.note)],
  ].filter(([, v]) => v);

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="grow ellipsis keep-case">{p.fileName}</h2>
        <span className="muted small">{p.sheet.rows.length} rækker</span>
        <button className="btn sm ghost" onClick={onCancel}>Fjern</button>
      </div>

      <div className="section-label">1 · Hvilken konto er filen fra?</div>
      <div className="row" style={{ marginBottom: 16 }}>
        <AccountSelect value={p.accountId} filter={(a) => a.kind === 'bank'} onChange={(accountId) => onChange({ ...p, accountId })} />
        {p.accountId && hint && <span className="small muted">Genkendt fra kontonavnet "{hint}" i filen</span>}
        {!p.accountId && (
          <>
            <span className="muted small">eller opret ny:</span>
            <input className="sm" placeholder="Navn på ny konto" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn sm primary" onClick={createAccount} disabled={!newName.trim()}>Opret konto</button>
            {hint && <span className="small muted">Navnet er hentet fra filen og bruges også til at genkende overførsler til kontoen</span>}
          </>
        )}
      </div>

      {broker && (
        <div className="banner info" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
          <input type="checkbox" id={`depot-${p.key}`} checked={setupSecurities} style={{ marginTop: 3 }} onChange={(e) => setSetupSecurities(e.target.checked)} />
          <label htmlFor={`depot-${p.key}`} className="small">
            <b>Det ligner en depot-eksport (fx fra en netbroker).</b> Saldoen er depotets <i>kontanter</i>. Et køb af værdipapirer er ikke en udgift – pengene flytter bare til dine værdipapirer.
            <div className="ink2" style={{ marginTop: 4 }}>
              Sæt kryds, så opretter jeg aktivposten <b>"{(data.accounts.find((a) => a.id === p.accountId)?.name ?? newName) || 'Depot'} – værdipapirer"</b>{data.settings.rulesEnabled ? ' og regler' : ''}, så KØBT/SOLGT bogføres som
              intern flytning dertil og UDBYTTE som indtægt. Skriv depotets værdi pr. periodeslut under Aktiver & passiver – stigningen bliver så til afkast.
            </div>
          </label>
        </div>
      )}

      <div className="section-label">2 · Hvad står i filens kolonner?</div>
      {complete && !showCols ? (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="chip user">Genkendt automatisk ✓</span>
          <span className="small ink2">{detected.map(([k, v]) => `${k}: ${v}`).join(' · ')}</span>
          <button className="btn sm ghost" onClick={() => setShowCols(true)}>Ret kolonner</button>
        </div>
      ) : (
        <>
          <p className="small ink2" style={{ marginBottom: 8 }}>
            Her fortæller du kun Finstate, <b>hvilken kolonne i filen der indeholder hvad</b> – det har intet med din kategorisering at gøre.
            Det huskes til næste gang, du importerer en fil i samme format.
          </p>
          <div className="row" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
            <label className="field">Tekst {colSelect('text', p.mapping.text?.[0], false)}<span className="muted">Posteringsteksten</span></label>
            {FIELDS.map((f) => (
              <label key={f.k} className="field">{f.label} {colSelect(f.k, p.mapping[f.k] as number | undefined, !f.required)}<span className="muted">{f.help}</span></label>
            ))}
          </div>
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table>
              <thead><tr>{p.sheet.header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>
                {p.sheet.rows.slice(0, 4).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="small ellipsis" style={{ maxWidth: 220 }}>{c}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        </>
      )}

      {hasBankCats && (
        <div className="banner info" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
          <input type="checkbox" id={`bank-${p.key}`} checked={useBank} style={{ marginTop: 3 }}
            onChange={(e) => update((d) => ({ ...d, settings: { ...d.settings, useBankCategories: e.target.checked } }))} />
          <label htmlFor={`bank-${p.key}`} className="small">
            <b>Brug bankens kategorier som forslag</b> ({colName(p.mapping.category)}{p.mapping.subcategory !== undefined ? ` › ${colName(p.mapping.subcategory)}` : ''})
            <div className="ink2">
              Du kategoriserer altid selv i <b>dit eget kategoritræ</b> i næste trin. Bankens kategori bruges højst til at foreslå noget, som du godkender eller retter.
              Slå den fra, hvis du hellere vil starte helt fra bunden. Kan ændres når som helst.
            </div>
          </label>
        </div>
      )}

      <div className="section-label">3 · Importér</div>
      {!complete && <div className="banner warn">Vælg mindst dato-, tekst- og beløbskolonne.</div>}
      {complete && !p.accountId && <div className="banner warn">Vælg hvilken konto filen tilhører (trin 1).</div>}
      {preview && (
        <div className="row">
          <span className="chip user">{fresh.length} nye</span>
          {preview.txs.length - fresh.length > 0 && <span className="chip">{preview.txs.length - fresh.length} findes allerede</span>}
          {noteFills.length > 0 && <span className="chip user">{noteFills.length} får din kommentar</span>}
          {dates.length > 0 && <span className="chip">{dates[0]} → {dates[dates.length - 1]}</span>}
          {p.mapping.balance === undefined ? (
            <span className="chip review">Ingen saldo – kan ikke afstemmes automatisk</span>
          ) : chain && chain.breaks.length ? (
            <span className="chip review">Saldokæde brudt {chain.breaks.length}× i filen</span>
          ) : (
            <span className="chip user" title="Hver saldo = forrige saldo + beløb, så ingen transaktioner mangler">Saldokæde ✓</span>
          )}
          {preview.errors.length > 0 && <span className="chip review" title={preview.errors.slice(0, 5).map((e) => `Række ${e.row}: ${e.reason}`).join('\n')}>{preview.errors.length} rækker sprunget over</span>}
          <span className="spacer" />
          <button className="btn primary" disabled={!fresh.length && !noteFills.length} onClick={doImport}>
            {fresh.length ? `Importér ${fresh.length} transaktioner` : `Tilføj ${noteFills.length} kommentarer`}
          </button>
        </div>
      )}
    </div>
  );
}

function AccountsSummary() {
  const e = useEngine();
  const update = useStore((s) => s.update);
  const banks = e.data.accounts.filter((a) => a.kind === 'bank');
  return (
    <div className="card">
      <h2>Importerede data</h2>
      {!e.data.txs.length ? <Empty>Ingen transaktioner endnu.</Empty> : (
        <table>
          <thead><tr><th>Konto</th><th className="num">Transaktioner</th><th>Fra</th><th>Til</th><th className="num">Seneste saldo</th><th>Saldokæde</th><th /></tr></thead>
          <tbody>
            {banks.map((a) => {
              const c = e.ledger.chains.get(a.id)!;
              const o = c.ordered;
              return (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td className="num">{o.length}</td>
                  <td>{o[0]?.date ?? '–'}</td>
                  <td>{o[o.length - 1]?.date ?? '–'}</td>
                  <td className="num">{o.length && o[o.length - 1].balance !== undefined ? <Money precise v={o[o.length - 1].balance!} /> : '–'}</td>
                  <td>{!o.length ? '–' : c.breaks.length ? <span className="chip review" title={c.breaks.map((b) => `${b.date}: ${kr(b.diff)}`).join('\n')}>{c.breaks.length} brud</span> : <span className="chip user">OK</span>}</td>
                  <td className="num">
                    {o.length > 0 && (
                      <button className="btn sm ghost danger" onClick={() => {
                        if (confirm(`Slet alle ${o.length} transaktioner på ${a.name}? Dine regler bevares, men manuelle valg på disse transaktioner forsvinder.`))
                          update((d) => ({ ...d, txs: d.txs.filter((t) => t.accountId !== a.id) }));
                      }}>Slet</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Depot: opret aktivposten for værdipapirerne (hvis den mangler), og lad køb/salg blive interne flytninger
 * og udbytte en indtægt. Med regler slået til oprettes regler; ellers sættes valget direkte på depotkontoens
 * transaktioner, som du ikke selv har afgjort.
 */
function setupDepot(d: import('../../domain/types').AppData, cashAccountId: string, periodId?: string) {
  const cash = d.accounts.find((a) => a.id === cashAccountId);
  if (!cash) return d;
  const name = `${cash.name} – værdipapirer`;
  let sec = d.accounts.find((a) => a.name === name);
  const accounts = [...d.accounts];
  if (!sec) {
    sec = { id: uid('acc'), name, kind: 'valuation', side: 'asset', aliases: [], defaultCategoryId: suggestCategory(d.categories, 'asset') };
    accounts.push(sec);
  }
  const secId = sec.id;
  const want: { pattern: string; then: Rule['then'] }[] = [
    { pattern: 'købt', then: { type: 'internal', targetAccountId: sec.id } },
    { pattern: 'solgt', then: { type: 'internal', targetAccountId: sec.id } },
    { pattern: 'udbytte', then: { type: 'income', categoryId: suggestCategory(d.categories, 'asset') } },
  ];
  if (d.settings.rulesEnabled !== true) {
    const txs = d.txs.map((t) => {
      if (t.accountId !== cashAccountId || t.manual || t.splits?.length) return t;
      const n = normalizeText(t.text);
      const w = want.find((x) => n.includes(x.pattern));
      return w ? { ...t, manual: w.then } : t;
    });
    return withAccountInPeriods({ ...d, accounts, txs }, secId, periodId);
  }
  const rules = [...d.rules];
  for (const w of want) {
    if (rules.some((r) => r.pattern === w.pattern && r.accountId === cashAccountId)) continue;
    rules.push({ id: uid('rule'), pattern: w.pattern, match: 'contains', accountId: cashAccountId, then: w.then, createdAt: new Date().toISOString() });
  }
  return withAccountInPeriods({ ...d, accounts, rules }, secId, periodId);
}
