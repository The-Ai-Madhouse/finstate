/** Navngivne versioner (milepæle), gemt som filer ved siden af datafilen (se server/storage.ts). */
import { versionSummary } from '../domain/diff';
import type { AppData } from '../domain/types';
import { clientBackend } from './clientStore';

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

// Data på denne computer (se clientStore.ts): versionerne ligger ved siden af datafilen i mappen/browseren.
const meta = (v: Version): VersionMeta => { const { data: _d, ...m } = v; void _d; return m; };

export async function listVersions(): Promise<VersionMeta[]> {
  const c = clientBackend();
  if (c) return (await c.listVersions()).map((t) => meta(JSON.parse(t) as Version)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return fetch('/api/versions', { cache: 'no-store' }).then((r) => json<VersionMeta[]>(r));
}
export async function getVersion(id: string): Promise<Version> {
  const c = clientBackend();
  if (c) { const t = await c.getVersion(id); if (t === null) throw new Error('Versionen findes ikke'); return JSON.parse(t) as Version; }
  return fetch(`/api/versions/${id}`, { cache: 'no-store' }).then((r) => json<Version>(r));
}
export async function deleteVersion(id: string) {
  const c = clientBackend();
  if (c) return c.deleteVersion(id);
  return fetch(`/api/versions/${id}`, { method: 'DELETE' }).then((r) => json(r));
}
export async function renameVersion(id: string, name: string, note?: string) {
  const c = clientBackend();
  if (c) {
    const v = await getVersion(id);
    if (name.trim()) v.name = name.trim();
    if (typeof note === 'string') v.note = note;
    return c.putVersion(id, JSON.stringify(v));
  }
  return fetch(`/api/versions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, note }) }).then((r) => json(r));
}

export async function saveVersion(data: AppData, name: string, opts: { note?: string; auto?: boolean } = {}): Promise<VersionMeta> {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const v: Version = { id: `${stamp}-${slug(name) || 'version'}`.toLowerCase(), name: name.trim(), note: opts.note?.trim() || undefined, createdAt: now.toISOString(), auto: opts.auto, summary: versionSummary(data), data };
  const c = clientBackend();
  if (c) await c.putVersion(v.id, JSON.stringify(v));
  else await fetch('/api/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }).then((r) => json(r));
  const { data: _d, ...meta } = v; void _d;
  return meta;
}
