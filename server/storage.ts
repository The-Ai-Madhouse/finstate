/**
 * Finstates server-del: login med 2FA og krypteret lagring i en mappe på computeren (eller en Raspberry Pi).
 *
 *  · Mappe: $FINSTATE_DIR eller ~/Documents/Finstate – altid UDEN FOR projektet, så data aldrig kan havne i git.
 *  · finstate.json (data) og versions/*.json er krypteret med AES-256-GCM. Nøglen låses kun op med adgangskode + 2FA
 *    eller et gyldigt login (cookie). Ældre ukrypterede filer krypteres, når login sættes op.
 *  · Skrives atomisk (midlertidig fil + omdøbning); forrige udgave gemmes som finstate.json.bak.
 *  · Kun Finstates egen side: Host/Origin skal være 127.0.0.1/localhost – eller et navn i $FINSTATE_ALLOWED_HOSTS
 *    (fx finstate.local – Pi'ens navn på hjemmenetværket).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import QRCode from 'qrcode';
import type { Plugin } from 'vite';
import { Auth, AuthError, SESSION_DAYS } from './auth.ts';
import { open, otpauthUri, seal } from './crypto.ts';

const MAX_BODY = 200 * 1024 * 1024;
const COOKIE = 'finstate_session';
const ENC = 'encrypted-v1';

export function storageDir(projectRoot: string): string {
  const raw = process.env.FINSTATE_DIR?.trim();
  const dir = raw ? resolve(raw.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), 'Documents', 'Finstate');
  const rel = relative(resolve(projectRoot), dir);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`Datamappen (${dir}) ligger inde i projektet – vælg en mappe udenfor, så dine data aldrig kommer i git.`);
  }
  return dir;
}

const pretty = (dir: string) => dir.replace(homedir(), '~');
const exists = (p: string) => stat(p).then(() => true, () => false);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('For stor');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function writeAtomic(file: string, text: string) {
  // Unikt navn, så to samtidige gemninger ikke deler samme midlertidige fil.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

const send = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const allowedHosts = () => (process.env.FINSTATE_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const hostOk = (h?: string) => {
  if (!h) return false;
  const name = h.toLowerCase().replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || allowedHosts().includes(name);
};
const isLocal = (h?: string) => !!h && /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(h);

/** Kun Finstate selv: anden Host/Origin (fx en fremmed hjemmeside eller DNS-rebinding) afvises. */
function allowed(req: IncomingMessage): boolean {
  if (!hostOk(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (!hostOk(new URL(origin).host)) return false; } catch { return false; }
  }
  return true;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** HttpOnly (kan ikke læses af JavaScript), SameSite=Strict (følger ikke med fra andre sider), Secure ved HTTPS. */
function sessionCookie(req: IncomingMessage, ticket: string, maxAgeSec: number) {
  const secure = !isLocal(req.headers.host) || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${encodeURIComponent(ticket)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

const label = (req: IncomingMessage) => {
  const ua = req.headers['user-agent'] ?? '';
  const dev = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Ukendt enhed';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${dev}${br ? ` · ${br}` : ''}`;
};

/** Krypteret fil: {finstate:"encrypted-v1", iv, tag, ct}. aad binder den til sin plads (data / en bestemt version). */
const encrypt = (dek: Buffer, text: string, aad: string) => JSON.stringify({ finstate: ENC, ...seal(dek, Buffer.from(text, 'utf8'), aad) });
const isEncrypted = (raw: string) => { try { return (JSON.parse(raw) as { finstate?: string }).finstate === ENC; } catch { return false; } };
function decrypt(dek: Buffer, raw: string, aad: string): string {
  const o = JSON.parse(raw) as { finstate?: string; iv: string; tag: string; ct: string };
  if (o.finstate !== ENC) return raw; // ældre ukrypteret fil (krypteres ved næste gemning)
  return open(dek, o, aad).toString('utf8');
}

/** Når login sættes op: krypter de data og versioner, der allerede ligger i mappen (fra før kryptering). */
async function encryptExisting(dir: string, dek: Buffer) {
  for (const f of [join(dir, 'finstate.json'), join(dir, 'finstate.json.bak')]) {
    if (!(await exists(f))) continue;
    const raw = await readFile(f, 'utf8');
    if (!isEncrypted(raw)) await writeAtomic(f, encrypt(dek, raw, 'data'));
  }
  const vdir = join(dir, 'versions');
  if (!(await exists(vdir))) return;
  for (const name of (await readdir(vdir)).filter((n) => n.endsWith('.json'))) {
    const f = join(vdir, name);
    const raw = await readFile(f, 'utf8');
    if (!isEncrypted(raw)) await writeAtomic(f, encrypt(dek, raw, `version:${name.slice(0, -5)}`));
  }
}

const safeId = (id: string) => /^[a-z0-9-]{1,80}$/.test(id);

export function handler(root: string) {
  const auths = new Map<string, Auth>();
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) return next();
    if (!allowed(req)) return send(res, 403, { error: 'Kun Finstate selv har adgang.' });
    let dir: string;
    try { dir = storageDir(root); } catch (e) { return send(res, 500, { error: (e as Error).message }); }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const auth = auths.get(dir) ?? auths.set(dir, new Auth(dir, writeAtomic)).get(dir)!;
    const dataFile = join(dir, 'finstate.json');
    const vdir = join(dir, 'versions');
    const ticket = cookie(req, COOKIE);
    const json = async <T,>() => JSON.parse(await readBody(req)) as T;
    try {
      // ---------------- Login (åbent – men begrænset af spærring efter forkerte forsøg)
      if (url.pathname === '/api/auth/status' && req.method === 'GET') return send(res, 200, await auth.status(ticket));
      if (url.pathname === '/api/auth/setup/start' && req.method === 'POST') {
        const { password } = await json<{ password: string }>();
        const { setupTicket, secret } = await auth.setupStart(String(password ?? ''));
        const uri = otpauthUri(secret);
        return send(res, 200, { setupTicket, secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
      }
      if (url.pathname === '/api/auth/setup/finish' && req.method === 'POST') {
        const { setupTicket, code } = await json<{ setupTicket: string; code: string }>();
        const r = await auth.setupFinish(String(setupTicket ?? ''), String(code ?? ''), label(req));
        await encryptExisting(dir, r.dek);
        return send(res, 200, { recovery: r.recovery, expiresAt: r.expiresAt }, { 'Set-Cookie': sessionCookie(req, r.ticket, SESSION_DAYS * 86400) });
      }
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const { password, code } = await json<{ password: string; code: string }>();
        const r = await auth.login(String(password ?? ''), String(code ?? ''), label(req));
        return send(res, 200, { expiresAt: r.expiresAt, recoveryLeft: r.recoveryLeft }, { 'Set-Cookie': sessionCookie(req, r.ticket, SESSION_DAYS * 86400) });
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        const { everywhere } = await json<{ everywhere?: boolean }>().catch(() => ({ everywhere: false }));
        if (ticket) await auth.logout(ticket, !!everywhere);
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      }

      // ---------------- Alt herunder kræver login – og datanøglen fra login'et
      const unlocked = await auth.unlock(ticket);
      if (!unlocked) return send(res, 401, { error: 'Log ind for at fortsætte.', configured: await auth.configured() });
      const { dek } = unlocked;

      if (url.pathname === '/api/auth/recovery' && req.method === 'POST') return send(res, 200, { recovery: await auth.newRecovery() });
      if (url.pathname === '/api/storage' && req.method === 'GET') {
        const has = await exists(dataFile);
        const st = has ? await stat(dataFile) : undefined;
        return send(res, 200, { dir: pretty(dir), exists: has, savedAt: st?.mtime.toISOString(), encrypted: true });
      }
      if (url.pathname === '/api/data') {
        if (req.method === 'GET') {
          if (!(await exists(dataFile))) return send(res, 404, { error: 'Ingen datafil endnu' });
          return send(res, 200, decrypt(dek, await readFile(dataFile, 'utf8'), 'data'));
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = await readBody(req);
          JSON.parse(body); // gem aldrig noget, der ikke er gyldig JSON
          if (await exists(dataFile)) await copyFile(dataFile, `${dataFile}.bak`);
          await writeAtomic(dataFile, encrypt(dek, body, 'data'));
          return send(res, 200, { ok: true, savedAt: new Date().toISOString() });
        }
      }
      if (url.pathname === '/api/versions') {
        await mkdir(vdir, { recursive: true, mode: 0o700 });
        if (req.method === 'GET') {
          const files = (await readdir(vdir)).filter((f) => f.endsWith('.json'));
          const metas = await Promise.all(files.map(async (f) => {
            const v = JSON.parse(decrypt(dek, await readFile(join(vdir, f), 'utf8'), `version:${f.slice(0, -5)}`)) as Record<string, unknown>;
            const { data: _d, ...meta } = v; void _d;
            return meta;
          }));
          return send(res, 200, metas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const v = JSON.parse(body) as { id?: string };
          if (!v.id || !safeId(v.id)) return send(res, 400, { error: 'Ugyldigt id' });
          await writeAtomic(join(vdir, `${v.id}.json`), encrypt(dek, body, `version:${v.id}`));
          return send(res, 200, { ok: true });
        }
      }
      const m = url.pathname.match(/^\/api\/versions\/([^/]+)$/);
      if (m && safeId(m[1])) {
        const f = join(vdir, `${m[1]}.json`);
        const aad = `version:${m[1]}`;
        if (!(await exists(f))) return send(res, 404, { error: 'Versionen findes ikke' });
        if (req.method === 'GET') return send(res, 200, decrypt(dek, await readFile(f, 'utf8'), aad));
        if (req.method === 'DELETE') { await rm(f); return send(res, 200, { ok: true }); }
        if (req.method === 'PATCH') {
          const patch = await json<{ name?: string; note?: string }>();
          const v = JSON.parse(decrypt(dek, await readFile(f, 'utf8'), aad)) as Record<string, unknown>;
          if (typeof patch.name === 'string' && patch.name.trim()) v.name = patch.name.trim();
          if (typeof patch.note === 'string') v.note = patch.note;
          await writeAtomic(f, encrypt(dek, JSON.stringify(v), aad));
          return send(res, 200, { ok: true });
        }
      }
      // Krypteret backup: hele mappen (data, versioner og login – uden aktive logins) i én fil.
      // Kan pakkes ud med scripts/unpack-backup.mjs og åbnes med samme adgangskode + 2FA.
      if (url.pathname === '/api/backup' && req.method === 'GET') {
        const files: Record<string, string> = {};
        const authFile = await auth.load();
        if (authFile) files['auth.json'] = JSON.stringify({ ...authFile, sessions: [], failures: undefined }, null, 2);
        if (await exists(dataFile)) files['finstate.json'] = await readFile(dataFile, 'utf8');
        if (await exists(vdir)) for (const n of (await readdir(vdir)).filter((x) => x.endsWith('.json'))) files[`versions/${n}`] = await readFile(join(vdir, n), 'utf8');
        const stamp = new Date().toISOString().slice(0, 10);
        return send(res, 200, { format: 'finstate-encrypted-backup', version: 1, createdAt: new Date().toISOString(), files },
          { 'Content-Disposition': `attachment; filename="finstate-krypteret-backup-${stamp}.json"` });
      }
      return send(res, 404, { error: 'Ukendt' });
    } catch (e) {
      if (e instanceof AuthError) return send(res, e.status, { error: e.message, retryAfter: e.retryAfter }, e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
      return send(res, 500, { error: (e as Error).message });
    }
  };
}

export function finstateStorage(): Plugin {
  let root = process.cwd();
  return {
    name: 'finstate-storage',
    configResolved(c) { root = c.root; },
    configureServer(server) { server.middlewares.use(handler(root)); },
    configurePreviewServer(server) { server.middlewares.use(handler(root)); },
  };
}
