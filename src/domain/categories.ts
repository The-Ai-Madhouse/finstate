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
