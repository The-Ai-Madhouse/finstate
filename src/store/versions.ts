/** Navngivne versioner (milepæle), gemt som filer ved siden af datafilen (se server/storage.ts). */
import { versionSummary } from '../domain/diff';
import type { AppData } from '../domain/types';

export interface VersionMeta {
  id: string;
  name: string;
  note?: string;
  createdAt: string;
  /** Automatisk gemt (fx før man gik tilbage til en anden version). */
  auto?: boolean;
  summary: ReturnType<typeof versionSummary>;
}
export interface Version extends VersionMeta { data: AppData }

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

const slug = (s: string) => s.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export const listVersions = () => fetch('/api/versions', { cache: 'no-store' }).then((r) => json<VersionMeta[]>(r));
export const getVersion = (id: string) => fetch(`/api/versions/${id}`, { cache: 'no-store' }).then((r) => json<Version>(r));
export const deleteVersion = (id: string) => fetch(`/api/versions/${id}`, { method: 'DELETE' }).then((r) => json(r));
export const renameVersion = (id: string, name: string, note?: string) =>
  fetch(`/api/versions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, note }) }).then((r) => json(r));

export async function saveVersion(data: AppData, name: string, opts: { note?: string; auto?: boolean } = {}): Promise<VersionMeta> {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const v: Version = { id: `${stamp}-${slug(name) || 'version'}`.toLowerCase(), name: name.trim(), note: opts.note?.trim() || undefined, createdAt: now.toISOString(), auto: opts.auto, summary: versionSummary(data), data };
  await fetch('/api/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }).then((r) => json(r));
  const { data: _d, ...meta } = v; void _d;
  return meta;
}
