import { useMemo, useRef, useState, type ReactNode } from 'react';
import { childrenOf, descendants, flattenTree, categoryPath, moveCategory } from '../../domain/categories';
import { defaultCategories, newCategoryId } from '../../domain/defaults';
import type { Category, Period } from '../../domain/types';
import { useEngine, usePeriod } from '../../store/actions';
import { useStore } from '../../store/store';
import { InfoBox, KIND_NAME, SearchCombo } from '../components/common';
import { SourcesDialog } from '../components/SourcesDialog';

type Kind = Category['kind'];
const KINDS: Kind[] = ['income', 'both', 'expense'];
const TITLE: Record<Kind, string> = { income: 'Indtægter', both: KIND_NAME.both, expense: 'Udgifter' };

/** Den kategori, der trækkes lige nu (kun inden for samme slags). */
let dragging: { id: string; kind: Kind } | undefined;

/** Uden valgt periode tælles og vises alt. */
const ALL: Period = { id: 'all', name: 'alle perioder', start: '0000-01-01', end: '9999-12-31' };

/**
 * Kategoritræet: træk for at flytte, opret og omdøb på stedet, se hvad en kategori bruges til i perioden
 * (klik på tallet) – og om den bruges som "uforklaret ændring" på en post, du taster selv (fx afkast på et depot).
 */
export function CategoriesSettings() {
  const e = useEngine();
  const data = e.data;
  const update = useStore((s) => s.update);
  const showPost = useStore((s) => s.showPost);
  const period = usePeriod() ?? ALL;
  // Hvor man er ved at oprette: øverst i en kolonne (kind) eller under en kategori (parent).
  const [adding, setAdding] = useState<{ kind: Kind; parentId?: string }>();
  const [asking, setAsking] = useState<string>();
  const [moving, setMoving] = useState<string>();
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<string>();
  const [sources, setSources] = useState<{ title: string; refs: Set<string>; kind: 'income' | 'expense' }>();

  // Brug i perioden: posteringer pr. kategori (transaktioner, værdiændringer og afskrivninger).
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of e.ledger.postings) {
      if (!p.ref.startsWith('cat:') || p.date < period.start || p.date > period.end) continue;
      const id = p.ref.slice(4);
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }, [e, period.start, period.end]);
  // Poster, du taster selv, hvor kategorien tager den uforklarede ændring (fx afkast eller renter).
  const unexplained = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of data.accounts) if (a.kind === 'valuation' && a.defaultCategoryId && !a.archived) m.set(a.defaultCategoryId, [...(m.get(a.defaultCategoryId) ?? []), a.name]);
    return m;
  }, [data.accounts]);

  const rename = (id: string, name: string) => update((d) => ({ ...d, categories: d.categories.map((c) => (c.id === id ? { ...c, name } : c)) }));
  const create = (kind: Kind, name: string, parentId?: string) => {
    const id = newCategoryId(data.categories, kind, name, parentId);
    update((d) => ({ ...d, categories: [...d.categories, { id, name, kind, parentId }] }));
    if (parentId) setFolded((f) => { const n = new Set(f); n.delete(parentId); return n; });
  };
  const remove = (c: Category) => {
    const ids = descendants(data.categories, c.id);
    update((d) => ({ ...d, categories: d.categories.filter((x) => !ids.includes(x.id)) }));
    setAsking(undefined);
  };
  const move = (id: string, to: { before?: string; parentId?: string | null }) => update((d) => ({ ...d, categories: moveCategory(d.categories, id, to) }));

  if (!data.categories.length) {
    return (
      <div className="card msg">
        <h2>Ingen kategorier endnu</h2>
        <p className="ink2" style={{ margin: '8px 0 12px' }}>Start med et eksempeltræ og ret det til – eller byg dit eget fra bunden.</p>
        <div className="row">
          <button className="btn primary" data-focus="settings:categories:seed" onClick={() => update((d) => ({ ...d, categories: defaultCategories() }))}>Indsæt eksempeltræ</button>
          {KINDS.map((k) => <button key={k} className="btn" onClick={() => setAdding({ kind: k })}>+ {k === 'both' ? 'Kategori der går begge veje' : `${TITLE[k].slice(0, -2)}skategori`}</button>)}
        </div>
        {adding && <AddRow kind={adding.kind} onAdd={(n) => create(adding.kind, n)} onClose={() => setAdding(undefined)} />}
      </div>
    );
  }

  const node = (c: Category, depth: number): ReactNode => {
    const kids = childrenOf(data.categories, c.id);
    const subtree = descendants(data.categories, c.id);
    const own = usage.get(c.id) ?? 0;
    const total = subtree.reduce((s, id) => s + (usage.get(id) ?? 0), 0);
    const isFolded = folded.has(c.id);
    const vals = unexplained.get(c.id) ?? [];
    const subVals = subtree.slice(1).flatMap((id) => unexplained.get(id) ?? []);
    const pk: 'income' | 'expense' = c.kind === 'expense' ? 'expense' : 'income';
    return (
      <div key={c.id} className={depth ? 'cat-sub' : 'cat-top'}>
        <div className={`cat-row ${over === c.id ? 'drop-over' : ''} ${asking === c.id ? 'asking' : ''}`}
          onDragOver={(ev) => { if (dragging && dragging.kind === c.kind && dragging.id !== c.id && !descendants(data.categories, dragging.id).includes(c.id)) { ev.preventDefault(); setOver(c.id); } }}
          onDragLeave={() => setOver(undefined)}
          onDrop={(ev) => { ev.preventDefault(); setOver(undefined); if (dragging) move(dragging.id, { before: c.id }); dragging = undefined; }}>
          <span className="drag-handle" draggable title="Træk for at flytte (slip på en anden kategori for at lægge den foran)" aria-hidden
            onDragStart={(ev) => { dragging = { id: c.id, kind: c.kind }; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', c.id); }}
            onDragEnd={() => { dragging = undefined; setOver(undefined); }}>⋮⋮</span>
          <button className={`caret-btn ${kids.length ? '' : 'none'}`} aria-label={isFolded ? `Fold ${c.name} ud` : `Fold ${c.name} sammen`} disabled={!kids.length}
            onClick={() => setFolded((f) => { const n = new Set(f); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}>
            <span className={`caret ${kids.length && !isFolded ? 'open' : ''}`} aria-hidden>{kids.length ? '›' : ''}</span>
          </button>
          <NameInput value={c.name} strong={!depth} onCommit={(n) => rename(c.id, n)} label={`Navn på ${c.name}`} />
          {!vals.length && subVals.length > 0 && isFolded && <span className="chip muted" title={`En underkategori tager den uforklarede ændring på ${subVals.join(', ')}`}>↻</span>}
          <button className={`cat-usage ${total ? '' : 'zero'}`} disabled={!total}
            title={total ? `Bruges ${own} gange i ${period.name}${total !== own ? ` (${total} med underkategorierne)` : ''} – klik for at se hvor` : `Ikke brugt i ${period.name}`}
            onClick={() => setSources({ title: categoryPath(data.categories, c.id), refs: new Set(subtree.map((id) => `cat:${id}`)), kind: pk })}>
            {total || '–'}
          </button>
          <span className="cat-actions">
            <button className="btn sm ghost" title={`Ny underkategori under ${c.name}`} onClick={() => setAdding({ kind: c.kind, parentId: c.id })}>+ Under</button>
            <button className="btn sm ghost" title="Flyt ind under en anden kategori" onClick={() => setMoving(moving === c.id ? undefined : c.id)}>Flyt…</button>
            <button className="btn sm ghost danger" onClick={() => setAsking(c.id)} aria-label={`Slet ${c.name}`}>✕</button>
          </span>
        </div>
        {vals.length > 0 && (
          <div className="cat-meta">
            {data.accounts.filter((a) => a.kind === 'valuation' && a.defaultCategoryId === c.id && !a.archived).map((a) => (
              <button key={a.id} className="cat-unexplained" title="Kategorien tager den del af postens værdiændring, som dine overførsler ikke forklarer – klik for at se posten i Aktiver & passiver"
                onClick={() => showPost(a.id, 'category')}>
                ↻ Uforklaret ændring på {a.name}
              </button>
            ))}
          </div>
        )}
        {asking === c.id && <DeleteConfirm c={c} subs={subtree.length - 1} uses={total} unexplained={[...vals, ...subVals]} onYes={() => remove(c)} onNo={() => setAsking(undefined)} />}
        {moving === c.id && (
          <div className="cat-inline">
            <span className="small ink2">Flyt "{c.name}" ind under:</span>
            <SearchCombo className="sm" value={c.parentId ?? '__top'} searchPlaceholder="Søg kategori…" ariaLabel={`Flyt ${c.name} ind under`} emptyText="Ingen kategori matcher"
              options={[
                { id: '__top', label: 'Øverste niveau' },
                ...flattenTree(data.categories, data.categories.filter((x) => !x.parentId && x.kind === c.kind))
                  .filter(({ cat }) => !subtree.includes(cat.id))
                  .map(({ cat, depth: dd }) => ({ id: cat.id, label: dd ? categoryPath(data.categories, cat.id) : cat.name, sub: dd > 0, depth: dd })),
              ]}
              onChange={(id) => { if (id) { move(c.id, { parentId: id === '__top' ? null : id }); setMoving(undefined); } }} />
            <button className="btn sm ghost" onClick={() => setMoving(undefined)} aria-label="Annullér">✕</button>
          </div>
        )}
        {!isFolded && kids.map((k) => node(k, depth + 1))}
        {adding?.parentId === c.id && <div className="cat-sub"><AddRow kind={c.kind} parentName={c.name} onAdd={(n) => create(c.kind, n, c.id)} onClose={() => setAdding(undefined)} /></div>}
      </div>
    );
  };

  return (
    <div className="stack">
      <InfoBox label="Sådan bruger du siden">
        Træk i <b>⋮⋮</b> for at flytte en kategori (slip den på en anden for at lægge den foran) – eller brug <b>Flyt…</b> for at lægge den ind under en anden.
        Tallet til højre er, hvor mange gange kategorien bruges i {period.name}; klik for at se transaktionerne. <b>↻ uforklaret ændring</b> betyder, at kategorien
        tager den del af en posts værdiændring, som dine overførsler ikke forklarer – fx afkast på et depot eller renter på et lån.
      </InfoBox>
      <div className="grid3">
        {KINDS.map((kind) => (
          <div key={kind} className="card"
            onDragOver={(ev) => { if (dragging?.kind === kind) ev.preventDefault(); }}
            onDrop={(ev) => { if (dragging?.kind === kind && !(ev.target as HTMLElement).closest('.cat-row')) { ev.preventDefault(); move(dragging.id, { parentId: null }); dragging = undefined; } }}>
            <div className="card-head">
              <h2 className="grow">{TITLE[kind]}</h2>
              <button className="btn sm" onClick={() => setAdding({ kind })}>+ Kategori</button>
            </div>
            {kind === 'both' && <InfoBox label="Hvad er begge veje?">Fx renter eller afkast: et positivt beløb er en indtægt, et negativt en udgift.</InfoBox>}
            {data.categories.filter((c) => c.kind === kind && !c.parentId).map((top) => node(top, 0))}
            {adding && !adding.parentId && adding.kind === kind && <AddRow kind={kind} onAdd={(n) => create(kind, n)} onClose={() => setAdding(undefined)} />}
            {!data.categories.some((c) => c.kind === kind) && !adding && <p className="small muted">Ingen endnu.</p>}
          </div>
        ))}
      </div>
      {sources && <SourcesDialog title={sources.title} refs={sources.refs} kind={sources.kind} period={period} onClose={() => setSources(undefined)} />}
    </div>
  );
}

/** Navnet rettes direkte i feltet og gemmes, når man forlader det (eller trykker Enter). Esc fortryder. */
function NameInput({ value, onCommit, strong, label }: { value: string; onCommit: (v: string) => void; strong?: boolean; label: string }) {
  const [txt, setTxt] = useState(value);
  const [focused, setFocused] = useState(false);
  const shown = focused ? txt : value;
  const save = () => { setFocused(false); const t = txt.trim(); if (t && t !== value) onCommit(t); };
  return (
    <input className={`cat-name ${strong ? 'strong' : ''}`} value={shown} aria-label={label}
      onFocus={() => { setTxt(value); setFocused(true); }}
      onChange={(ev) => setTxt(ev.target.value)}
      onBlur={save}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
        if (ev.key === 'Escape') { setTxt(value); setFocused(false); (ev.target as HTMLInputElement).blur(); }
      }} />
  );
}

/** Ny kategori på stedet – Enter opretter og gør klar til den næste; Esc lukker. */
function AddRow({ kind, parentName, onAdd, onClose }: { kind: Kind; parentName?: string; onAdd: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const add = () => { const n = name.trim(); if (!n) return; onAdd(n); setName(''); ref.current?.focus(); };
  return (
    <div className="cat-inline newpost">
      <span className="small ink2">{parentName ? `Ny under ${parentName}:` : `Ny ${kind === 'income' ? 'indtægts' : kind === 'expense' ? 'udgifts' : ''}kategori:`}</span>
      <input ref={ref} className="sm grow" autoFocus value={name} placeholder="Navn – Enter for at tilføje" aria-label="Navn på ny kategori"
        onChange={(ev) => setName(ev.target.value)}
        onKeyDown={(ev) => { if (ev.key === 'Enter') add(); if (ev.key === 'Escape') onClose(); }} />
      <button className="btn sm primary" disabled={!name.trim()} onClick={add}>Opret</button>
      <button className="btn sm ghost" onClick={onClose} aria-label="Luk">✕</button>
    </div>
  );
}

/** Sletning bekræftes på stedet – med hvad der også forsvinder. */
function DeleteConfirm({ c, subs, uses, unexplained, onYes, onNo }: { c: Category; subs: number; uses: number; unexplained: string[]; onYes: () => void; onNo: () => void }) {
  return (
    <div className="cat-inline cat-delete" role="alertdialog" aria-label={`Slet ${c.name}`}>
      <span className="small">
        Slet <b>{c.name}</b>{subs ? ` og ${subs} underkategori${subs > 1 ? 'er' : ''}` : ''}?
        {uses > 0 && <> Den bruges {uses} gange – beløbene vises som "Slettet kategori", indtil du giver dem en ny.</>}
        {unexplained.length > 0 && <> Den tager også den uforklarede ændring på {unexplained.join(', ')}.</>}
      </span>
      <span className="spacer" />
      <button className="btn sm" autoFocus onClick={onNo}>Annullér</button>
      <button className="btn sm danger-solid" onClick={onYes}>Slet</button>
    </div>
  );
}
