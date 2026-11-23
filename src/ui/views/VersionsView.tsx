import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { diffData, type DataDiff } from '../../domain/diff';
import { buildEngine } from '../../domain/engine';
import { dateShort, kr } from '../../domain/format';
import type { AppData } from '../../domain/types';
import { useStore } from '../../store/store';
import { deleteVersion, getVersion, listVersions, renameVersion, saveVersion, type Version, type VersionMeta } from '../../store/versions';
import { Empty, InfoBox, Money } from '../components/common';

const when = (iso: string) => new Date(iso).toLocaleString('da-DK', { dateStyle: 'medium', timeStyle: 'short' });

/** Versionsstyring: gem milepæle, se hvad der er ændret siden – og gå tilbage. */
export function VersionsView() {
  const data = useStore((s) => s.data);
  const save = useStore((s) => s.saveStatus);
  const [versions, setVersions] = useState<VersionMeta[]>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [compareId, setCompareId] = useState<string>();
  const [compare, setCompare] = useState<Version>();
  const [asking, setAsking] = useState<{ id: string; kind: 'restore' | 'delete' }>();
  const [renaming, setRenaming] = useState<string>();
  const [flash, setFlash] = useState<string>();

  const reload = () => listVersions().then((v) => { setVersions(v); setError(undefined); return v; }).catch((e: Error) => { setError(e.message); return [] as VersionMeta[]; });
  useEffect(() => { void reload().then((v) => setCompareId((c) => c ?? v[0]?.id)); }, []);
  useEffect(() => {
    if (!compareId) { setCompare(undefined); return; }
    let live = true;
    getVersion(compareId).then((v) => live && setCompare(v)).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [compareId]);

  const doSave = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const m = await saveVersion(data, name, { note });
      setName(''); setNote('');
      await reload();
      setCompareId(m.id);
      setFlash(`"${m.name}" er gemt.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const restore = async (id: string) => {
    setBusy(true);
    try {
      const v = await getVersion(id);
      // Gem først den nuværende tilstand, så man altid kan fortryde.
      await saveVersion(data, `Før gendannelse af "${v.name}"`, { auto: true });
      useStore.getState().replaceAll(v.data);
      await reload();
      setCompareId(id);
      setFlash(`Du er tilbage ved "${v.name}". Din tidligere tilstand er gemt som en automatisk version.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setAsking(undefined); }
  };

  if (save.mode !== 'file') {
    return (
      <div className="stack">
        <h1>Versioner</h1>
        <div className="banner warn">Versioner gemmes som filer på din computer og kræver, at Finstate kører via <code>npm start</code>. {save.error}</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>Versioner</h1>
      <InfoBox label="Hvad er en version?">
        Et øjebliksbillede af alle dine data – fx når balancen går op, eller et financial statement er færdigt. Bagefter kan du se, hvad du har ændret siden,
        og gå tilbage, hvis noget gik galt. {save.client === 'browser' ? 'Versionerne ligger i browserens lager på denne computer.' : <>Versionerne ligger som filer i {save.dir}/versions.</>}
      </InfoBox>
      {error && <div className="banner error">{error} <span className="spacer" /><button className="btn sm ghost" onClick={() => setError(undefined)}>Luk</button></div>}
      {flash && <div className="banner info">{flash} <span className="spacer" /><button className="btn sm ghost" onClick={() => setFlash(undefined)}>Luk</button></div>}

      <div className="card">
        <h2>Gem en version</h2>
        <div className="row" style={{ alignItems: 'flex-end' }} onKeyDown={(e) => { if (e.key === 'Enter') void doSave(); }}>
          <label className="field grow">Navn<input value={name} placeholder="Fx 2025 – balancen går op" onChange={(e) => setName(e.target.value)} aria-label="Navn på version" /></label>
          <label className="field grow">Note (valgfri)<input value={note} placeholder="Hvad er nået?" onChange={(e) => setNote(e.target.value)} /></label>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={doSave}>Gem version</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="grow">Ændringer siden</h2>
          {versions && versions.length > 0 && (
            <select value={compareId ?? ''} onChange={(e) => setCompareId(e.target.value || undefined)} aria-label="Sammenlign med version">
              {versions.map((v) => <option key={v.id} value={v.id}>{v.name} – {when(v.createdAt)}</option>)}
            </select>
          )}
        </div>
        {!versions?.length ? <Empty>Gem din første version ovenfor – så kan du bagefter se, hvad der er ændret siden.</Empty>
          : !compare ? <div className="small muted">Indlæser …</div>
          : <ChangesSince before={compare.data} after={data} name={compare.name} />}
      </div>

      <div className="card">
        <h2>Gemte versioner</h2>
        {!versions ? <div className="small muted">Indlæser …</div> : !versions.length ? <Empty>Ingen versioner endnu.</Empty> : (
          <table>
            <thead><tr><th>Version</th><th>Gemt</th><th>Indhold</th><th /></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} className={compareId === v.id ? 'selected' : undefined}>
                  <td>
                    {renaming === v.id
                      ? <RenameInput v={v} onDone={async (n) => { setRenaming(undefined); if (n && n !== v.name) { await renameVersion(v.id, n); await reload(); } }} />
                      : <><b>{v.name}</b>{v.auto && <span className="chip" style={{ marginLeft: 6 }}>automatisk</span>}</>}
                    {v.note && <div className="small muted">{v.note}</div>}
                  </td>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{when(v.createdAt)}</td>
                  <td className="small ink2">{v.summary.txs} transaktioner · {v.summary.categories} kategorier · {v.summary.periods.join(', ') || 'ingen perioder'}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {asking?.id === v.id ? (
                      <span className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <span className="small">{asking.kind === 'restore' ? 'Gå tilbage hertil? Din nuværende tilstand gemmes først.' : 'Slet versionen?'}</span>
                        <button className="btn sm" onClick={() => setAsking(undefined)}>Annullér</button>
                        {asking.kind === 'restore'
                          ? <button className="btn sm primary" disabled={busy} onClick={() => restore(v.id)}>Gå tilbage</button>
                          : <button className="btn sm danger-solid" onClick={async () => { await deleteVersion(v.id); setAsking(undefined); const l = await reload(); if (compareId === v.id) setCompareId(l[0]?.id); }}>Slet</button>}
                      </span>
                    ) : (
                      <>
                        <button className="btn sm ghost" onClick={() => setCompareId(v.id)} disabled={compareId === v.id}>Sammenlign</button>
                        <button className="btn sm ghost" onClick={() => setRenaming(v.id)}>Omdøb</button>
                        <button className="btn sm" onClick={() => setAsking({ id: v.id, kind: 'restore' })}>Gå tilbage…</button>
                        <button className="btn sm ghost danger" aria-label={`Slet ${v.name}`} onClick={() => setAsking({ id: v.id, kind: 'delete' })}>✕</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RenameInput({ v, onDone }: { v: VersionMeta; onDone: (name?: string) => void }) {
  const [t, setT] = useState(v.name);
  return <input className="sm" autoFocus value={t} onChange={(e) => setT(e.target.value)} onBlur={() => onDone(t.trim())}
    onKeyDown={(e) => { if (e.key === 'Enter') onDone(t.trim()); if (e.key === 'Escape') onDone(); }} aria-label="Nyt navn" />;
}

/** Hvad er ændret siden versionen – grupperet, med regnskabstallene først. */
function ChangesSince({ before, after, name }: { before: AppData; after: AppData; name: string }) {
  const d: DataDiff = useMemo(() => diffData(before, after), [before, after]);
  const figures = useMemo(() => {
    const eb = buildEngine(before), ea = buildEngine(after);
    return after.periods.filter((p) => before.periods.some((x) => x.id === p.id)).map((p) => {
      const pb = before.periods.find((x) => x.id === p.id)!;
      const sb = eb.statement(pb), sa = ea.statement(p);
      return { name: p.name, rows: [
        { label: 'Resultat', b: sb.result, a: sa.result },
        { label: 'Indtægter', b: sb.incomeTotal, a: sa.incomeTotal },
        { label: 'Udgifter', b: sb.expenseTotal, a: sa.expenseTotal },
        { label: 'Nettoformue ultimo', b: sb.equityClose, a: sa.equityClose },
        { label: 'Ukategoriseret', b: sb.uncategorized.income + sb.uncategorized.expense, a: sa.uncategorized.income + sa.uncategorized.expense },
      ].filter((r) => r.a !== r.b) };
    }).filter((p) => p.rows.length);
  }, [before, after]);
  const acc = (id: string) => after.accounts.find((a) => a.id === id)?.name ?? before.accounts.find((a) => a.id === id)?.name ?? '';
  if (!d.total && !figures.length) return <div className="small"><span className="chip user">✓ Ingen ændringer</span> siden "{name}".</div>;
  return (
    <div className="col changes" style={{ gap: 10 }}>
      <div className="small ink2">{d.total} {d.total === 1 ? 'ændring' : 'ændringer'} siden "{name}".</div>
      {figures.map((p) => (
        <Group key={p.name} title={`Regnskabet ${p.name}`} count={p.rows.length} open>
          <table className="small"><tbody>
            {p.rows.map((r) => (
              <tr key={r.label}><td>{r.label}</td><td className="num muted">{kr(r.b)}</td><td className="muted">→</td><td className="num"><b>{kr(r.a)}</b></td><td className="num"><Money v={r.a - r.b} signed /></td></tr>
            ))}
          </tbody></table>
        </Group>
      ))}
      <Group title="Transaktioner med ny kategori, type eller post" count={d.txChanged.length}>
        {d.txChanged.map((x) => <Line key={x.tx.id} date={x.tx.date} text={x.tx.text} extra={<><span className="muted">{x.before}</span> → <b>{x.after}</b></>} txId={x.tx.id} />)}
      </Group>
      <Group title="Nye transaktioner" count={d.txAdded.length}>
        {d.txAdded.map((t) => <Line key={t.id} date={t.date} text={`${acc(t.accountId)} · ${t.text}`} extra={<Money v={t.amount} decimals colored />} txId={t.id} />)}
      </Group>
      <Group title="Fjernede transaktioner" count={d.txRemoved.length}>
        {d.txRemoved.map((t) => <Line key={t.id} date={t.date} text={`${acc(t.accountId)} · ${t.text}`} extra={<Money v={t.amount} decimals colored />} />)}
      </Group>
      <Group title="Dine noter" count={d.notesChanged.length}>
        {d.notesChanged.map((x) => <Line key={x.tx.id} date={x.tx.date} text={x.tx.text} extra={<><span className="muted">{x.before || '–'}</span> → <b>{x.after || '(fjernet)'}</b></>} txId={x.tx.id} />)}
      </Group>
      <Group title="Kategorier" count={d.catAdded.length + d.catRemoved.length + d.catChanged.length}>
        {d.catAdded.map((c) => <div key={c.id} className="small">+ <b>{c.name}</b></div>)}
        {d.catRemoved.map((c) => <div key={c.id} className="small neg">− {c.name}</div>)}
        {d.catChanged.map((c, i) => <div key={i} className="small"><span className="muted">{c.before}</span> → <b>{c.after}</b></div>)}
      </Group>
      <Group title="Aktiver & passiver" count={d.accAdded.length + d.accRemoved.length + d.accChanged.length + d.valuations.length}>
        {d.accAdded.map((a) => <div key={a.id} className="small">+ <b>{a.name}</b></div>)}
        {d.accRemoved.map((a) => <div key={a.id} className="small neg">− {a.name}</div>)}
        {d.accChanged.map((a, i) => <div key={i} className="small"><b>{a.name}</b>: {a.what}</div>)}
        {d.valuations.map((v, i) => <div key={`v${i}`} className="small"><b>{v.account}</b> pr. {dateShort(v.date)}: <span className="muted">{v.before === undefined ? '–' : kr(v.before)}</span> → <b>{v.after === undefined ? '(fjernet)' : kr(v.after)}</b></div>)}
      </Group>
      <Group title="Financial statements" count={d.periodsAdded.length + d.periodsRemoved.length}>
        {d.periodsAdded.map((n) => <div key={n} className="small">+ <b>{n}</b></div>)}
        {d.periodsRemoved.map((n) => <div key={n} className="small neg">− {n}</div>)}
      </Group>
      <Group title="Parring & afstemning" count={d.pairing.length}>
        {d.pairing.map((p) => <div key={p.label} className="small">{p.label}: <span className="muted">{p.before}</span> → <b>{p.after}</b></div>)}
      </Group>
    </div>
  );
}

function Group({ title, count, children, open }: { title: string; count: number; children: ReactNode; open?: boolean }) {
  const [all, setAll] = useState(false);
  if (!count) return null;
  const items = Array.isArray(children) ? (children as ReactNode[]).flat() : [children];
  const shown = all ? items : items.slice(0, 30);
  return (
    <details className="change-group" open={open || count <= 5}>
      <summary><b>{title}</b> <span className="chip">{count}</span></summary>
      <div className="change-body">
        {shown}
        {items.length > shown.length && <button className="btn sm ghost" onClick={() => setAll(true)}>Vis alle {items.length}</button>}
      </div>
    </details>
  );
}

function Line({ date, text, extra, txId }: { date: string; text: string; extra: ReactNode; txId?: string }) {
  const showTx = useStore((s) => s.showTx);
  return (
    <div className="row small change-line">
      <span className="muted" style={{ minWidth: 64 }}>{dateShort(date)}</span>
      {txId ? <button className="linkish ellipsis" style={{ maxWidth: 320, textDecoration: 'none' }} onClick={() => showTx(txId)}>{text}</button> : <span className="ellipsis" style={{ maxWidth: 320 }}>{text}</span>}
      <span className="spacer" />
      <span>{extra}</span>
    </div>
  );
}
