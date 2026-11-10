/**
 * Kategoritræet kan have vilkårlig dybde (kategori › underkategori › under-underkategori …).
 * Hjælpere til at gå op og ned i træet – beskyttet mod cirkler i gamle/ødelagte data.
 */
import type { Category } from './types';

/** Stien fra roden ned til kategorien (inkl. den selv). */
export function ancestors(categories: Category[], id: string): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: Category[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** Kategorien og alle dens underkategorier (i alle niveauer). */
export function descendants(categories: Category[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of categories) if (c.parentId === out[i] && !out.includes(c.id)) out.push(c.id);
  return out;
}

export const childrenOf = (categories: Category[], id?: string) => categories.filter((c) => (c.parentId ?? undefined) === id);

/** "Bolig › El & varme › Varme" */
export const categoryPath = (categories: Category[], id: string, sep = ' › ') => ancestors(categories, id).map((c) => c.name).join(sep);

/** Træet i læserækkefølge (dybde først) med niveau – til lister og dropdowns. */
export function flattenTree(categories: Category[], roots: Category[] = categories.filter((c) => !c.parentId)): { cat: Category; depth: number }[] {
  const out: { cat: Category; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (c: Category, depth: number) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push({ cat: c, depth });
    for (const k of childrenOf(categories, c.id)) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * Flyt en kategori: foran en anden (bliver dens søskende) eller sidst under en ny overkategori (null = øverste niveau).
 * Rækkefølgen blandt søskende er rækkefølgen i listen. En kategori kan ikke flyttes ind under sig selv.
 */
export function moveCategory(categories: Category[], id: string, to: { before?: string; parentId?: string | null }): Category[] {
  const c = categories.find((x) => x.id === id);
  if (!c || to.before === id) return categories;
  const target = to.before ? categories.find((x) => x.id === to.before) : undefined;
  if (to.before && !target) return categories;
  const parentId = target ? target.parentId : to.parentId ?? undefined;
  const parent = parentId ? categories.find((x) => x.id === parentId) : undefined;
  if (parentId && (!parent || descendants(categories, id).includes(parentId))) return categories;
  if (target && target.kind !== c.kind) return categories;
  if (parent && parent.kind !== c.kind) return categories;
  const moved: Category = { ...c };
  if (parentId) moved.parentId = parentId; else delete moved.parentId;
  const rest = categories.filter((x) => x.id !== id);
  const at = target ? rest.findIndex((x) => x.id === target.id) : rest.length;
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
