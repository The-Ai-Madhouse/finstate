/**
 * Data på din egen computer, når Finstate hentes fra en anden maskine (fx en Raspberry Pi med FINSTATE_DATA=client).
 *
 *  · Mappe (Chrome, Edge, Brave, Opera på computer): browseren læser og skriver direkte i en mappe, du vælger – fx
 *    Dokumenter/Finstate. Samme format som når Finstate kører lokalt (npm start): finstate.json og versions/*.json er
 *    krypteret med AES-256-GCM, og nøglen ligger i local.key i mappen. Så kan samme mappe bruges begge veje.
 *  · Browser (Safari, Firefox, telefon): data gemmes i browserens eget lager på denne computer (ikke krypteret).
 *
 * Intet sendes til Pi'en – den viser kun appen.
 */

export type ClientKind = 'folder' | 'browser';

export interface ClientBackend {
  kind: ClientKind;
  /** Til visning: mappens navn eller "denne browser". */
  label: string;
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  listVersions(): Promise<string[]>;
  getVersion(id: string): Promise<string | null>;
  putVersion(id: string, text: string): Promise<void>;
  deleteVersion(id: string): Promise<void>;
  /** Alle filer – til en backup i samme format som serverens krypterede backup. */
  backupFiles(): Promise<Record<string, string>>;
}

let active: ClientBackend | undefined;
export const clientBackend = () => active;
export const setClientBackend = (b: ClientBackend | undefined) => { active = b; };
export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window && window.isSecureContext;

// ------------------------------------------------------------------ lille nøgle/værdi-lager i IndexedDB

const DB = 'finstate-client';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await idb();
  return new Promise<T>((res, rej) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { db.close(); res(req.result as T); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
export const kvGet = <T>(k: string) => kv<T | undefined>('readonly', (s) => s.get(k));
export const kvSet = (k: string, v: unknown) => kv<void>('readwrite', (s) => s.put(v, k));
export const kvDel = (k: string) => kv<void>('readwrite', (s) => s.delete(k));
const kvKeys = () => kv<IDBValidKey[]>('readonly', (s) => s.getAllKeys());

/** Hvad brugeren valgte sidst på denne computer. */
export interface ClientChoice { kind: ClientKind; dir?: FileSystemDirectoryHandle }
export const loadChoice = () => kvGet<ClientChoice>('choice');
export const saveChoice = (c: ClientChoice) => kvSet('choice', c);
export const forgetChoice = () => kvDel('choice');

// ------------------------------------------------------------------ kryptering (samme format som server/crypto.ts)

const ENC = 'encrypted-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };

interface Sealed { finstate: string; iv: string; tag: string; ct: string }
const isSealed = (o: unknown): o is Sealed => !!o && typeof o === 'object' && (o as Sealed).finstate === ENC;

export async function importKey(raw: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
/** Node gemmer ciffertekst og tag hver for sig – WebCrypto vil have dem i forlængelse af hinanden. */
export async function decryptText(key: CryptoKey, raw: string, aad: string): Promise<string> {
  const o = JSON.parse(raw) as unknown;
  if (!isSealed(o)) return raw; // ældre ukrypteret fil – krypteres ved næste gemning
  const ct = unb64(o.ct), tag = unb64(o.tag);
  const both = new Uint8Array(ct.length + tag.length);
  both.set(ct); both.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv), additionalData: enc.encode(aad), tagLength: 128 }, key, both);
  return dec.decode(plain);
}
export async function encryptText(key: CryptoKey, text: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad), tagLength: 128 }, key, enc.encode(text)));
  return JSON.stringify({ finstate: ENC, iv: b64(iv), tag: b64(out.slice(out.length - 16)), ct: b64(out.slice(0, out.length - 16)) });
}

// ------------------------------------------------------------------ mappe på computeren

async function fileText(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
}
async function writeText(dir: FileSystemDirectoryHandle, name: string, text: string) {
  // createWritable skriver til en midlertidig fil og bytter først ved close() – en afbrudt gemning efterlader den gamle fil.
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(text);
  await w.close();
}

/** Har browseren (stadig) lov til at læse og skrive i mappen? Spørger kun, hvis ask = true (kræver et klik). */
export async function folderPermission(dir: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  const opts = { mode: 'readwrite' as const };
  const h = dir as FileSystemDirectoryHandle & { queryPermission(o: object): Promise<PermissionState>; requestPermission(o: object): Promise<PermissionState> };
  if ((await h.queryPermission(opts)) === 'granted') return true;
  return ask && (await h.requestPermission(opts)) === 'granted';
}

export async function folderBackend(dir: FileSystemDirectoryHandle): Promise<ClientBackend> {
  // Nøglen: local.key i mappen (som ved lokal brug). Har mappen et login (fx en backup fra Pi'en), skal den låses op én gang lokalt.
  let keyB64 = (await fileText(dir, 'local.key'))?.trim();
  if (!keyB64) {
    if (await fileText(dir, 'auth.json')) {
      throw new Error('Mappen er beskyttet med adgangskode og 2FA. Åbn den én gang med "npm start" på denne computer – så kan den bruges herfra bagefter.');
    }
    keyB64 = b64(crypto.getRandomValues(new Uint8Array(32)));
    await writeText(dir, 'local.key', keyB64);
  }
  const key = await importKey(unb64(keyB64));
  const versions = () => dir.getDirectoryHandle('versions', { create: true });
  return {
    kind: 'folder',
    label: dir.name,
    async read() {
      const raw = await fileText(dir, 'finstate.json');
      return raw === null ? null : decryptText(key, raw, 'data');
    },
    async write(text) {
      JSON.parse(text); // gem aldrig noget, der ikke er gyldig JSON
      const old = await fileText(dir, 'finstate.json');
      if (old !== null) await writeText(dir, 'finstate.json.bak', old);
      await writeText(dir, 'finstate.json', await encryptText(key, text, 'data'));
    },
    async listVersions() {
      const v = await versions();
      const out: string[] = [];
      for await (const [name, h] of (v as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (h.kind !== 'file' || !name.endsWith('.json')) continue;
        out.push(await decryptText(key, await (await (h as FileSystemFileHandle).getFile()).text(), `version:${name.slice(0, -5)}`));
      }
      return out;
    },
    async getVersion(id) {
      const raw = await fileText(await versions(), `${id}.json`);
      return raw === null ? null : decryptText(key, raw, `version:${id}`);
    },
    async putVersion(id, text) { await writeText(await versions(), `${id}.json`, await encryptText(key, text, `version:${id}`)); },
    async deleteVersion(id) { await (await versions()).removeEntry(`${id}.json`); },
    async backupFiles() {
      const files: Record<string, string> = { 'local.key': keyB64! };
      const data = await fileText(dir, 'finstate.json');
      if (data !== null) files['finstate.json'] = data;
      const v = await versions();
      for await (const [name, h] of (v as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (h.kind === 'file' && name.endsWith('.json')) files[`versions/${name}`] = await (await (h as FileSystemFileHandle).getFile()).text();
      }
      return files;
    },
  };
}

// ------------------------------------------------------------------ browserens eget lager

export function browserBackend(): ClientBackend {
  return {
    kind: 'browser',
    label: 'denne browser',
    read: async () => (await kvGet<string>('data')) ?? null,
    write: async (text) => { JSON.parse(text); await kvSet('data', text); },
    listVersions: async () => {
      const keys = (await kvKeys()).map(String).filter((k) => k.startsWith('version:'));
      return Promise.all(keys.map(async (k) => (await kvGet<string>(k))!));
    },
    getVersion: async (id) => (await kvGet<string>(`version:${id}`)) ?? null,
    putVersion: (id, text) => kvSet(`version:${id}`, text),
    deleteVersion: (id) => kvDel(`version:${id}`),
    backupFiles: async (): Promise<Record<string, string>> => {
      const data = await kvGet<string>('data');
      return data ? { 'finstate.json': data } : {};
    },
  };
}
