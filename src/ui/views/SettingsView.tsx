import { deleteStatement, withNewPeriod } from '../components/PeriodPrompt';
import { useEffect, useMemo, useState } from 'react';
import { applyBackup, parseBackup } from '../../domain/backup';
import { ruleMatches } from '../../domain/classify';
import { demoData } from '../../domain/demo';
import { defaultCategories, emptyData, newCategoryId } from '../../domain/defaults';
import { normalizeText } from '../../domain/normalize';
import { TX_TYPE_LABEL, bankKey, type Account, type Category, type Rule, type TxType } from '../../domain/types';
import { uid } from '../../domain/util';
import { deleteRule, setBankMap, upsertRule, useEngine } from '../../store/actions';
import { storageUsage, useStore } from '../../store/store';
import { exportBackup } from '../backup';
import { AccountSelect, AmountInput, CategoryCombo, ClassEditor, Empty, KIND_NAME, SearchCombo, TypeSelect, InfoBox } from '../components/common';
import { KIND_LABEL, NO_TYPE, addAccountType } from '../../domain/accountTypes';

type Tab = 'accounts' | 'categories' | 'rules' | 'bank' | 'periods' | 'data';
const TABS: [Tab, string][] = [['accounts', 'Poster & typer'], ['categories', 'Kategorier'], ['rules', 'Regler'], ['bank', 'Bankkategorier'], ['periods', 'Perioder'], ['data', 'Backup & data']];

export function SettingsView() {
  const hasCategories = useStore((s) => s.data.categories.length > 0);
  const linked = useStore((s) => s.settingsTab) as Tab | undefined;
  const [tab, setTab] = useState<Tab>(linked ?? (hasCategories ? 'accounts' : 'categories'));
  // Direkte links (fx "Rediger kategorier →") åbner den rigtige fane.
  useEffect(() => { if (linked) setTab(linked); }, [linked]);
  return (
    <div className="stack">
      <h1>Indstillinger</h1>
      <div className="tabs" role="tablist">
        {TABS.map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{l}</button>)}
      </div>
      {tab === 'accounts' && <Accounts />}
      {tab === 'categories' && <Categories />}
      {tab === 'rules' && <Rules />}
      {tab === 'bank' && <BankMapping />}
      {tab === 'periods' && <Periods />}
      {tab === 'data' && <DataTab />}
    </div>
  );
}

// ------------------------------------------------------------------ Konti

function Accounts() {
  const data = useStore((s) => s.data);
  const update = useStore((s) => s.update);
  const setView = useStore((s) => s.setView);
  const set = (id: string, patch: Partial<Account>) => update((d) => ({ ...d, accounts: d.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  return (
    <div className="stack">
    <AccountTypes />
    <div className="card">
      <h2>Poster – aktiver og passiver</h2>
      <div className="card-head">
        <InfoBox>
          Alle dine poster. Det er nemmest at tilføje og udfylde dem direkte i balancen – her kan du rette navne, typer og hvordan de genkendes i overførselstekster
          (fx "Min opsparing" i "Overførsel til Min opsparing").
        </InfoBox>
        <button className="btn primary" onClick={() => setView('balance')}>Åbn Aktiver & passiver →</button>
      </div>
      {!data.accounts.length ? <Empty>Ingen konti endnu. Bankkonti oprettes, når du importerer; andre poster tilføjer du i Aktiver & passiver.</Empty> : (
        <table>
          <thead><tr><th>Navn</th><th>Type</th><th>Saldo</th><th>Genkendes i overførsler som</th><th>Uforklaret ændring → / Åbningssaldo</th><th /></tr></thead>
          <tbody>
            {data.accounts.map((a) => {
              const used = data.txs.some((t) => t.accountId === a.id) || data.valuations.some((v) => v.accountId === a.id);
              return (
                <tr key={a.id} style={a.archived ? { opacity: 0.5 } : undefined}>
                  <td><input value={a.name} onChange={(ev) => set(a.id, { name: ev.target.value })} /></td>
                  <td><TypeSelect value={a.typeId} onChange={(typeId) => set(a.id, { typeId })} /></td>
                  <td className="small ink2">{KIND_LABEL[a.kind]}</td>
                  <td><AliasInput value={a.aliases} onChange={(aliases) => set(a.id, { aliases })} /></td>
                  <td>
                    {a.kind === 'tracked' ? <span className="small muted">Følger dine overførsler</span>
                      : a.kind === 'valuation'
                      ? <CategoryCombo className="sm" value={a.defaultCategoryId} allowClear="Ukategoriseret" onChange={(defaultCategoryId) => set(a.id, { defaultCategoryId })} />
                      : <AmountInput className="sm" value={a.openingBalance} placeholder="auto fra saldo" onCommit={(openingBalance) => set(a.id, { openingBalance })} ariaLabel="Åbningssaldo" />}
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm ghost" onClick={() => set(a.id, { archived: !a.archived })}>{a.archived ? 'Genåbn' : 'Arkivér'}</button>
                    {!used && <button className="btn sm ghost danger" onClick={() => update((d) => ({ ...d, accounts: d.accounts.filter((x) => x.id !== a.id) }))}>Slet</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
    </div>
  );
}

/** Brugerens egne posttyper – ingen er foruddefinerede, og "Ingen type" findes altid. */
function AccountTypes() {
  const data = useStore((s) => s.data);
  const update = useStore((s) => s.update);
  const [name, setName] = useState('');
  const used = (id: string) => data.accounts.filter((a) => a.typeId === id).length;
  const add = () => { if (name.trim()) { update((d) => addAccountType(d, name).data); setName(''); } };
  const remove = (id: string) => {
    const n = used(id);
    if (n && !confirm(`Typen bruges af ${n} poster. De får "${NO_TYPE}". Slet alligevel?`)) return;
    update((d) => ({ ...d, accountTypes: d.accountTypes.filter((t) => t.id !== id), accounts: d.accounts.map((a) => (a.typeId === id ? { ...a, typeId: undefined } : a)) }));
  };
  return (
    <div className="card">
      <h2>Posttyper</h2>
      <InfoBox>
        Dine egne labels til poster i balancen, fx "Opsparing", "Investeringer", "Lån" eller "Personer". Typen er kun et label – om saldoen følger dine overførsler
        eller tastes selv, vælger du pr. post. "{NO_TYPE}" er altid en mulighed.
      </InfoBox>
      {data.accountTypes.map((t) => (
        <div key={t.id} className="row" style={{ marginBottom: 4 }}>
          <input className="sm" value={t.name} aria-label="Typens navn"
            onChange={(ev) => update((d) => ({ ...d, accountTypes: d.accountTypes.map((x) => (x.id === t.id ? { ...x, name: ev.target.value } : x)) }))} />
          <span className="small muted">{used(t.id)} poster</span>
          <button className="btn sm ghost danger" onClick={() => remove(t.id)} aria-label={`Slet ${t.name}`}>✕</button>
        </div>
      ))}
      <div className="row" onKeyDown={(ev) => ev.key === 'Enter' && add()}>
        <input className="sm" placeholder="Ny type, fx Opsparing" value={name} onChange={(ev) => setName(ev.target.value)} aria-label="Ny type" />
        <button className="btn sm" disabled={!name.trim()} onClick={add}>+ Tilføj type</button>
      </div>
    </div>
  );
}

function AliasInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [txt, setTxt] = useState(value.join(', '));
  return <input style={{ width: '100%' }} value={txt} onChange={(ev) => setTxt(ev.target.value)} onBlur={() => onChange(txt.split(',').map((s) => s.trim()).filter(Boolean))} />;
}


// ------------------------------------------------------------------ Kategorier

function Categories() {
  const data = useStore((s) => s.data);
  const update = useStore((s) => s.update);
  const e = useEngine();
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of e.resolved.values()) for (const l of r.lines) if (l.categoryId) m.set(l.categoryId, (m.get(l.categoryId) ?? 0) + 1);
    return m;
  }, [e]);
  const set = (id: string, patch: Partial<Category>) => update((d) => ({ ...d, categories: d.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const add = (kind: Category['kind'], parentId?: string) => {
    const name = prompt(parentId ? 'Navn på underkategori' : 'Navn på kategori');
    if (!name?.trim()) return;
    const id = newCategoryId(data.categories, kind, name.trim(), parentId);
    update((d) => ({ ...d, categories: [...d.categories, { id, name: name.trim(), kind, parentId }] }));
  };
  const remove = (c: Category) => {
    const n = (usage.get(c.id) ?? 0) + data.categories.filter((x) => x.parentId === c.id).length;
    if (n && !confirm(`"${c.name}" bruges ${n} steder. Slet alligevel? Beløbene vises som "Slettet kategori", indtil du flytter dem.`)) return;
    update((d) => ({ ...d, categories: d.categories.filter((x) => x.id !== c.id && x.parentId !== c.id) }));
  };
  if (!data.categories.length) {
    return (
      <div className="card msg">
        <h2>Ingen kategorier endnu</h2>
        <p className="ink2" style={{ margin: '8px 0 12px' }}>Start med et eksempeltræ og ret det til – eller byg dit eget fra bunden.</p>
        <div className="row">
          <button className="btn primary" onClick={() => update((d) => ({ ...d, categories: defaultCategories() }))}>Indsæt eksempeltræ</button>
          <button className="btn" onClick={() => add('expense')}>+ Udgiftskategori</button>
          <button className="btn" onClick={() => add('income')}>+ Indtægtskategori</button>
          <button className="btn" onClick={() => add('both')}>+ Kategori der går begge veje</button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid3">
      {(['income', 'both', 'expense'] as const).map((kind) => (
        <div key={kind} className="card">
          <div className="card-head"><h2 className="grow">{kind === 'income' ? 'Indtægter' : kind === 'expense' ? 'Udgifter' : KIND_NAME.both}</h2><button className="btn sm" onClick={() => add(kind)}>+ Kategori</button></div>
          {kind === 'both' && <InfoBox label="Hvad er begge veje?">Fx renter eller afkast: et positivt beløb er en indtægt, et negativt en udgift.</InfoBox>}
          {data.categories.filter((c) => c.kind === kind && !c.parentId).map((top) => (
            <div key={top.id} style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>
              <div className="row">
                <input className="grow" value={top.name} onChange={(ev) => set(top.id, { name: ev.target.value })} style={{ fontWeight: 600 }} />
                <span className="small muted">{usage.get(top.id) ?? 0}</span>
                <button className="btn sm ghost" onClick={() => add(kind, top.id)}>+ Under</button>
                <button className="btn sm ghost danger" onClick={() => remove(top)} aria-label={`Slet ${top.name}`}>✕</button>
              </div>
              {data.categories.filter((c) => c.parentId === top.id).map((c) => (
                <div key={c.id} className="row" style={{ paddingLeft: 24, marginTop: 4 }}>
                  <input className="grow sm" value={c.name} onChange={(ev) => set(c.id, { name: ev.target.value })} />
                  <span className="small muted">{usage.get(c.id) ?? 0}</span>
                  <button className="btn sm ghost danger" onClick={() => remove(c)} aria-label={`Slet ${c.name}`}>✕</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Regler

function Rules() {
  const data = useStore((s) => s.data);
  const update = useStore((s) => s.update);
  const enabled = data.settings.rulesEnabled === true;
  const [q, setQ] = useState('');
  const [test, setTest] = useState('');
  const [newRule, setNewRule] = useState<string>();
  const hits = useMemo(() => {
    const m = new Map<string, number>();
    const norm = data.txs.map((t) => [t, normalizeText(t.text)] as const);
    for (const r of data.rules) m.set(r.id, norm.filter(([t, n]) => ruleMatches(r, t, n)).length);
    return m;
  }, [data.txs, data.rules]);
  const rules = data.rules.filter((r) => !q || r.pattern.includes(q.toLowerCase())).sort((a, b) => a.pattern.localeCompare(b.pattern, 'da'));
  return (
    <div className="stack">
    <BuiltInSuggestions />
    <div className="card">
      <h2>Regler (avanceret)</h2>
      <label className="check" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(ev) => update((d) => ({ ...d, settings: { ...d.settings, rulesEnabled: ev.target.checked } }))} style={{ marginTop: 3 }} />
        <div className="grow">
          <div><b>Brug regler</b>{data.rules.length > 0 && <span className="chip" style={{ marginLeft: 6 }}>{data.rules.length} regler{enabled ? '' : ' (slået fra)'}</span>}</div>
          <div className="small muted">
            En regel kategoriserer automatisk alle transaktioner med en bestemt tekst – også fremtidige. Uden regler afgør du selv hver transaktion
            (med "Lignende" kan du stadig give mange den samme kategori på én gang).
          </div>
        </div>
      </label>
    </div>
    {enabled && (
    <div className="card">
      <h2>Dine regler</h2>
      <div className="card-head">
        <InfoBox>Regler matcher den <i>normaliserede</i> tekst (små bogstaver, uden datoer, numre og "Dankort-nota"). "Præcis" er sikrest; "indeholder" fanger varianter. Dine manuelle valg på enkelte transaktioner har altid forrang.</InfoBox>
        <input placeholder="Søg i regler" value={q} onChange={(ev) => setQ(ev.target.value)} />
        <button className="btn" onClick={() => { const id = uid('rule'); setNewRule(id); setQ(''); upsertRule({ id, pattern: '', match: 'contains', then: { type: 'expense' }, createdAt: new Date().toISOString() }); }}>+ Regel</button>
      </div>
      <div className="row small" style={{ marginBottom: 10 }}>
        <span className="ink2">Test normalisering:</span>
        <input className="sm" style={{ width: 280 }} placeholder="Dankort-nota Købmand Hansen 1234 13.05" value={test} onChange={(ev) => setTest(ev.target.value)} />
        {test && <code>→ "{normalizeText(test)}"</code>}
      </div>
      {!rules.length ? <Empty>Ingen regler.</Empty> : (
        <table>
          <thead><tr><th>Tekst</th><th>Match</th><th>Retning</th><th>Konto</th><th style={{ minWidth: 380 }}>Bliver til</th><th className="num">Træffere</th><th /></tr></thead>
          <tbody>{rules.map((r) => <RuleRow key={r.id} r={r} hits={hits.get(r.id) ?? 0} autoFocus={r.id === newRule} />)}</tbody>
        </table>
      )}
    </div>
    )}
  </div>
  );
}

/**
 * Alt det, Finstate selv foreslår – synligt og til/fra. Dine egne regler og valg har altid forrang,
 * og forslag skal godkendes i Kategorisér (undtagen interne overførsler, som kun flytter penge).
 */
function BuiltInSuggestions() {
  const e = useEngine();
  const update = useStore((s) => s.update);
  const st = e.data.settings;
  const count = (src: string) => [...e.resolved.values()].filter((r) => r.source === src).length;
  const set = (patch: Partial<typeof st>) => update((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
  const items: { key: 'autoAlias' | 'autoPair' | 'useBankCategories'; title: string; text: string; src: string[] }[] = [
    { key: 'autoAlias', title: 'Kontonavn i teksten → Intern overførsel', text: 'Står en af dine kontis navne/genkendelsestekster i posteringen (fx "Overførsel til Min opsparing"), foreslås den som intern overførsel til den konto.', src: ['alias'] },
    { key: 'autoPair', title: 'Samme beløb ud og ind på to af dine konti → Intern overførsel', text: 'Ligner teksten en overførsel, og står samme beløb modsat på en anden af dine konti inden for få dage, parres de som én intern overførsel.', src: ['pair'] },
    { key: 'useBankCategories', title: 'Bankens kategori → forslag til din kategori', text: 'Bankens egen kategori (fx "Dagligvarer") bruges som første gæt. Det står altid som forslag, du skal godkende.', src: ['bankmap', 'bankguess'] },
  ];
  return (
    <div className="card">
      <h2>Automatiske forslag (indbygget)</h2>
      <InfoBox>
        Finstate kan selv foreslå noget. Her er <b>alt</b>, den gør automatisk – slå det fra, du ikke vil have.
        Dine egne valg og regler vinder altid.
      </InfoBox>
      {items.map((it) => {
        const on = st[it.key] !== false;
        const n = it.src.reduce((s, x) => s + count(x), 0);
        return (
          <label key={it.key} className="check" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={on} onChange={(ev) => set({ [it.key]: ev.target.checked })} style={{ marginTop: 3 }} />
            <div className="grow">
              <div><b>{it.title}</b> {on && n > 0 && <span className="chip">{n} transaktioner lige nu</span>}</div>
              <div className="small muted">{it.text}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function RuleRow({ r, hits, autoFocus }: { r: Rule; hits: number; autoFocus?: boolean }) {
  const [pattern, setPattern] = useState(r.pattern);
  const set = (patch: Partial<Rule>) => upsertRule({ ...r, ...patch });
  return (
    <tr>
      <td><input autoFocus={autoFocus} placeholder="tekst i posteringen" value={pattern} onChange={(ev) => setPattern(ev.target.value)} onBlur={() => set({ pattern: normalizeText(pattern) || pattern.toLowerCase() })} /></td>
      <td><select className="sm" value={r.match} onChange={(ev) => set({ match: ev.target.value as Rule['match'] })}><option value="exact">Præcis</option><option value="contains">Indeholder</option></select></td>
      <td><select className="sm" value={r.sign ?? ''} onChange={(ev) => set({ sign: (ev.target.value || undefined) as Rule['sign'] })}><option value="">Begge</option><option value="in">Ind</option><option value="out">Ud</option></select></td>
      <td><AccountSelect className="sm" value={r.accountId} onChange={(accountId) => set({ accountId })} placeholder="Alle" filter={(a) => a.kind === 'bank'} /></td>
      <td><ClassEditor compact value={r.then} amount={r.sign === 'in' ? 1 : r.sign === 'out' ? -1 : 0} onChange={(then) => set({ then })} /></td>
      <td className="num">{hits}</td>
      <td><button className="btn sm ghost danger" onClick={() => deleteRule(r.id)} aria-label="Slet regel">✕</button></td>
    </tr>
  );
}

// ------------------------------------------------------------------ Bankkategorier

function BankMapping() {
  const data = useStore((s) => s.data);
  const pairs = useMemo(() => {
    const m = new Map<string, { cat?: string; sub?: string; n: number; sample: string }>();
    for (const t of data.txs) {
      if (!t.bankCategory && !t.bankSubcategory) continue;
      const k = bankKey(t.bankCategory, t.bankSubcategory);
      const cur = m.get(k);
      if (cur) cur.n++;
      else m.set(k, { cat: t.bankCategory, sub: t.bankSubcategory, n: 1, sample: t.text });
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [data.txs]);
  return (
    <div className="card">
      <h2>Bankens kategorier</h2>
      <label className="row" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={data.settings.useBankCategories !== false} onChange={(ev) => useStore.getState().update((d) => ({ ...d, settings: { ...d.settings, useBankCategories: ev.target.checked } }))} />
        <b>Brug bankens kategorier som forslag</b>
        <span className="small muted">– slå fra for at kategorisere helt fra bunden (dine regler og valg påvirkes ikke)</span>
      </label>
      <InfoBox>
        Bankens egne kategorier bruges som første gæt. Map dem til dit træ én gang – resultatet vises stadig som et <i>forslag</i>, du godkender i Kategorisér.
        Kategorier der dækker over mange slags poster (fx "Overførsler") er bedst at lade stå tomme.
      </InfoBox>
      {!pairs.length ? <Empty>Ingen bankkategorier fundet i de importerede data.</Empty> : (
        <table>
          <thead><tr><th>Bankens kategori</th><th className="num">Antal</th><th>Eksempel</th><th style={{ minWidth: 400 }}>Mit gæt</th><th /></tr></thead>
          <tbody>
            {pairs.map(([k, p]) => {
              const m = data.bankMap[k];
              return (
                <tr key={k}>
                  <td>{p.cat}{p.sub ? <span className="muted"> › {p.sub}</span> : ''}</td>
                  <td className="num">{p.n}</td>
                  <td className="small muted ellipsis" style={{ maxWidth: 200 }}>{p.sample}</td>
                  <td>
                    {m ? <ClassEditor compact value={m} amount={0} onChange={(c) => setBankMap(k, { type: c.type, categoryId: c.categoryId })} />
                      : <div className="row">{(['expense', 'income', 'internal'] as TxType[]).map((t) => <button key={t} className="btn sm" onClick={() => setBankMap(k, { type: t })}>{TX_TYPE_LABEL[t]}</button>)}</div>}
                  </td>
                  <td>{m && <button className="btn sm ghost" onClick={() => setBankMap(k, undefined)}>Ryd</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Perioder

function Periods() {
  const data = useStore((s) => s.data);
  const update = useStore((s) => s.update);
  const [newPeriod, setNewPeriod] = useState<string>();
  const set = (id: string, patch: Partial<(typeof data.periods)[number]>) => update((d) => ({ ...d, periods: d.periods.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  return (
    <div className="card">
      <h2>Perioder</h2>
      <InfoBox>Perioder er blot datointervaller over samme bogføring – du kan have både halvår og helår, og sammenligne vilkårligt.</InfoBox>
      <table>
        <thead><tr><th>Navn</th><th>Start</th><th>Slut</th><th>Sammenlign med</th><th /></tr></thead>
        <tbody>
          {[...data.periods].sort((a, b) => (a.start < b.start ? -1 : 1)).map((p) => (
            <tr key={p.id}>
              <td><input autoFocus={p.id === newPeriod} placeholder="Navn, fx 2025 H2" value={p.name} onChange={(ev) => set(p.id, { name: ev.target.value })} /></td>
              <td><input type="date" value={p.start} onChange={(ev) => set(p.id, { start: ev.target.value })} /></td>
              <td><input type="date" value={p.end} onChange={(ev) => set(p.id, { end: ev.target.value })} /></td>
              <td>
                <SearchCombo options={data.periods.filter((x) => x.id !== p.id).map((x) => ({ id: x.id, label: x.name || `${x.start} – ${x.end}` }))} value={p.compareToId}
                  allowClear="Automatisk" searchPlaceholder="Søg periode…" ariaLabel="Sammenlign med periode" onChange={(compareToId) => set(p.id, { compareToId })} />
              </td>
              <td><button className="btn sm ghost danger" onClick={() => confirm(`Er du helt sikker på, at du vil slette ${p.name}?\n\nDet fjerner perioden, dens slideshow-tekster og bekræftelsen af balancen. Det kan ikke fortrydes uden backup.\n\nDine transaktioner, kategorier, regler og værdier bevares.`) && deleteStatement(p.id)}>Slet</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn" style={{ marginTop: 12 }} onClick={() => {
        const y = new Date().getFullYear();
        const id = uid('p'); setNewPeriod(id);
        update((d) => withNewPeriod(d, { id, name: '', start: `${y}-01-01`, end: `${y}-12-31` }));
      }}>+ Periode</button>
    </div>
  );
}

// ------------------------------------------------------------------ Backup & data

function DataTab() {
  const data = useStore((s) => s.data);
  const replaceAll = useStore((s) => s.replaceAll);
  const setPeriod = useStore((s) => s.setPeriod);
  const [msg, setMsg] = useState<{ level: 'info' | 'error'; text: string }>();
  const kb = Math.round(storageUsage() / 1024);

  const onFile = async (f: File, mode: 'replace' | 'merge') => {
    try {
      const b = parseBackup(await f.text());
      if (mode === 'replace' && b.kind === 'full' && !confirm(`Erstat ALLE nuværende data med backuppen fra ${b.exportedAt.slice(0, 10)}?`)) return;
      replaceAll(applyBackup(data, b, mode));
      setMsg({ level: 'info', text: `${b.kind === 'full' ? 'Backup' : 'Regelpakke'} fra ${b.exportedAt.slice(0, 10)} indlæst (${mode === 'merge' ? 'flettet' : 'erstattet'}).` });
    } catch (e) {
      setMsg({ level: 'error', text: (e as Error).message });
    }
  };
  const fileBtn = (label: string, mode: 'replace' | 'merge', primary = false) => (
    <label className={`btn ${primary ? 'primary' : ''}`}>
      {label}
      <input type="file" accept=".json,application/json" hidden onChange={(ev) => { const f = ev.target.files?.[0]; if (f) onFile(f, mode); ev.target.value = ''; }} />
    </label>
  );

  return (
    <div className="stack">
      {msg && <div className={`banner ${msg.level}`}>{msg.text}</div>}
      <div className="grid2">
        <div className="card">
          <h2>Eksportér</h2>
          <p className="ink2 small" style={{ marginBottom: 12 }}>
            Alt ligger kun i denne browsers localStorage ({kb} KB brugt af ca. 5.000 KB). Ryddes browserdata, er det væk – så gem en backup efter hver arbejdsgang,
            fx i en krypteret mappe. Backuppen indeholder dine bankdata: del den ikke.
          </p>
          <div className="row">
            <button className="btn primary" onClick={() => exportBackup('full')}>Fuld backup (.json)</button>
            <button className="btn" onClick={() => exportBackup('rules')}>Kun regler, kategorier & konti</button>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Regelpakken indeholder ingen transaktioner og kan bruges til at starte forfra eller flytte til en anden computer.</p>
        </div>
        <div className="card">
          <h2>Importér</h2>
          <p className="ink2 small" style={{ marginBottom: 12 }}><b>Flet</b> tilføjer og opdaterer på id (backuppens version vinder). <b>Erstat</b> overskriver alt med backuppen.</p>
          <div className="row">
            {fileBtn('Flet backup/regler…', 'merge', true)}
            {fileBtn('Erstat med backup…', 'replace')}
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Demo & nulstilling</h2>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => {
            if (data.txs.length && !confirm('Demodata erstatter dine nuværende data. Har du taget backup?')) return;
            replaceAll(demoData()); setPeriod('p-2026-h1'); setMsg({ level: 'info', text: 'Fiktive demodata indlæst.' });
          }}>Indlæs fiktive demodata</button>
          <button className="btn danger" onClick={() => {
            if (!confirm('Slet ALLE data i denne browser? Det kan ikke fortrydes uden backup.')) return;
            replaceAll(emptyData()); setPeriod(undefined); setMsg({ level: 'info', text: 'Alle data er slettet.' });
          }}>Slet alle data</button>
          <button className="btn" onClick={() => {
            if (!confirm('Slet transaktioner, værdier og perioder, men behold konti, kategorier, regler og bankmapping?')) return;
            replaceAll({ ...emptyData(), accounts: data.accounts, categories: data.categories, rules: data.rules, bankMap: data.bankMap, importProfiles: data.importProfiles });
            setPeriod(undefined);
          }}>Start forfra – behold regler</button>
        </div>
      </div>
    </div>
  );
}
