import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { open, seal } from '../../server/crypto';
import { decryptText, encryptText, folderBackend, importKey } from './clientStore';

/** En mappe i hukommelsen med samme metoder som browserens FileSystemDirectoryHandle. */
class FakeDir {
  files = new Map<string, string>();
  dirs = new Map<string, FakeDir>();
  name: string;
  constructor(name: string) { this.name = name; }
  async getFileHandle(n: string, o?: { create?: boolean }) {
    if (!this.files.has(n)) { if (!o?.create) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' }); this.files.set(n, ''); }
    return {
      kind: 'file' as const,
      getFile: async () => ({ text: async () => this.files.get(n)! }),
      createWritable: async () => { let buf = ''; return { write: async (t: string) => { buf += t; }, close: async () => { this.files.set(n, buf); } }; },
    };
  }
  async getDirectoryHandle(n: string, o?: { create?: boolean }) {
    if (!this.dirs.has(n)) { if (!o?.create) throw new Error('NotFound'); this.dirs.set(n, new FakeDir(n)); }
    return this.dirs.get(n)!;
  }
  async removeEntry(n: string) { this.files.delete(n); }
  async *entries() { for (const n of this.files.keys()) yield [n, await this.getFileHandle(n)] as const; }
}
const asDir = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;

describe('data på denne computer', () => {
  it('encrypts exactly like the server (AES-256-GCM, iv/tag/ct) – both ways', async () => {
    const raw = randomBytes(32);
    const key = await importKey(new Uint8Array(raw));
    // Browser → server
    const fromBrowser = JSON.parse(await encryptText(key, '{"hej":1}', 'data'));
    expect(fromBrowser.finstate).toBe('encrypted-v1');
    expect(open(raw, fromBrowser, 'data').toString('utf8')).toBe('{"hej":1}');
    // Server → browser
    const fromServer = JSON.stringify({ finstate: 'encrypted-v1', ...seal(raw, Buffer.from('{"x":"æøå"}'), 'version:v1') });
    expect(await decryptText(key, fromServer, 'version:v1')).toBe('{"x":"æøå"}');
    // Forkert plads (aad) afvises.
    await expect(decryptText(key, fromServer, 'data')).rejects.toThrow();
  });

  it('starts an empty folder with a new key, saves encrypted, keeps a .bak and versions', async () => {
    const d = new FakeDir('Finstate');
    const b = await folderBackend(asDir(d));
    expect(await b.read()).toBeNull();
    expect(d.files.get('local.key')).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    await b.write('{"a":1}');
    await b.write('{"a":2}');
    expect(d.files.get('finstate.json')).not.toContain('"a"');
    expect(await b.read()).toBe('{"a":2}');
    const key = Buffer.from(d.files.get('local.key')!, 'base64');
    expect(open(key, JSON.parse(d.files.get('finstate.json.bak')!), 'data').toString()).toBe('{"a":1}');
    await b.putVersion('v1', '{"id":"v1"}');
    expect(await b.listVersions()).toEqual(['{"id":"v1"}']);
    expect(Object.keys(await b.backupFiles()).sort()).toEqual(['finstate.json', 'local.key', 'versions/v1.json']);
    await b.deleteVersion('v1');
    expect(await b.listVersions()).toEqual([]);
    await expect(b.write('ikke json')).rejects.toThrow();
  });

  it('opens the folder that "npm start" uses (local.key) – and refuses a folder that has a login', async () => {
    const raw = randomBytes(32);
    const d = new FakeDir('Finstate');
    d.files.set('local.key', raw.toString('base64'));
    d.files.set('finstate.json', JSON.stringify({ finstate: 'encrypted-v1', ...seal(raw, Buffer.from('{"fra":"npm start"}'), 'data') }));
    expect(await (await folderBackend(asDir(d))).read()).toBe('{"fra":"npm start"}');
    const locked = new FakeDir('Pi-backup');
    locked.files.set('auth.json', '{}');
    await expect(folderBackend(asDir(locked))).rejects.toThrow(/npm start/);
  });
});
