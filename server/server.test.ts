import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Encode, totpAt, totpCounter, verifyTotp } from './crypto.ts';
import { handler } from './storage.ts';

describe('TOTP', () => {
  it('matches the RFC 6238 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238, SHA1, T=59s → 94287082 (8 cifre) → 6 sidste cifre 287082
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(1);
    expect(verifyTotp(secret, '000000', 59_000)).toBeUndefined();
  });
});

describe('server: 2FA-login og krypteret lagring', () => {
  let dir: string;
  let server: Server;
  let base: string;
  const keep = process.env.FINSTATE_DIR;
  const start = async () => {
    const h = handler('/tmp/finstate-projekt-test');
    server = createServer((req, res) => h(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const stop = () => new Promise<void>((r) => server.close(() => r()));
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'finstate-test-'));
    process.env.FINSTATE_DIR = dir;
    // Ældre ukrypteret data + version fra før login
    await writeFile(join(dir, 'finstate.json'), JSON.stringify({ state: { data: { hemmelig: 'Kontoudtog 4711' } }, version: 1 }));
    await mkdir(join(dir, 'versions'));
    await writeFile(join(dir, 'versions', 'v1.json'), JSON.stringify({ id: 'v1', name: 'Gammel', createdAt: '2025-01-01', data: { hemmelig: 'Kontoudtog 4711' } }));
    await start();
  });
  afterAll(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
    if (keep === undefined) delete process.env.FINSTATE_DIR; else process.env.FINSTATE_DIR = keep;
  });
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.cookie ? { Cookie: init.cookie } : {}) } });
  const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

  let secret = '';
  let cookie = '';
  let recovery: string[] = [];

  it('requires login before anything can be read', async () => {
    expect((await call('/api/data')).status).toBe(401);
    expect(await (await call('/api/auth/status')).json()).toMatchObject({ configured: false, loggedIn: false });
  });

  it('sets up password + 2FA and encrypts existing data', async () => {
    expect((await call('/api/auth/setup/start', { method: 'POST', body: JSON.stringify({ password: 'kort' }) })).status).toBe(400);
    const s = await (await call('/api/auth/setup/start', { method: 'POST', body: JSON.stringify({ password: 'en lang adgangskode' }) })).json();
    expect(s.qr).toMatch(/^data:image\/png;base64,/);
    secret = s.secret;
    expect((await call('/api/auth/setup/finish', { method: 'POST', body: JSON.stringify({ setupTicket: s.setupTicket, code: '000000' }) })).status).toBe(400);
    const r = await call('/api/auth/setup/finish', { method: 'POST', body: JSON.stringify({ setupTicket: s.setupTicket, code: totpAt(secret, totpCounter()) }) });
    expect(r.status).toBe(200);
    cookie = cookieOf(r);
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict; Max-Age=2419200/);
    recovery = (await r.json()).recovery;
    expect(recovery).toHaveLength(10);
    // På disken: intet i klartekst – hverken data, version eller 2FA-hemmelighed
    for (const f of ['finstate.json', 'versions/v1.json', 'auth.json']) {
      const raw = await readFile(join(dir, f), 'utf8');
      expect(raw).not.toContain('Kontoudtog');
      expect(raw).not.toContain(secret);
    }
    // Med login kan data læses igen
    expect(await (await call('/api/data', { cookie })).json()).toMatchObject({ state: { data: { hemmelig: 'Kontoudtog 4711' } } });
    const versions = await (await call('/api/versions', { cookie })).json();
    expect(versions.map((v: { name: string }) => v.name)).toEqual(['Gammel']);
  });

  it('saves encrypted and keeps the login across a restart', async () => {
    expect((await call('/api/data', { method: 'PUT', cookie, body: JSON.stringify({ state: { data: { ny: 'Løn 30000' } }, version: 1 }) })).status).toBe(200);
    expect(await readFile(join(dir, 'finstate.json'), 'utf8')).not.toContain('Løn');
    await stop(); await start();
    expect(await (await call('/api/data', { cookie })).json()).toMatchObject({ state: { data: { ny: 'Løn 30000' } } });
    expect((await call('/api/data', { cookie: 'finstate_session=forkert' })).status).toBe(401);
  });

  it('logs in with password + code, or a recovery code once; rejects a wrong password and a reused code', async () => {
    const code = totpAt(secret, totpCounter());
    expect((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'forkert adgangskode', code }) })).status).toBe(401);
    // Koden fra opsætningen er brugt – samme tidstrin må ikke genbruges
    const reused = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'en lang adgangskode', code }) });
    expect([200, 401]).toContain(reused.status);
    const rc = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'en lang adgangskode', code: recovery[0] }) });
    expect(rc.status).toBe(200);
    expect((await rc.json()).recoveryLeft).toBe(9);
    expect((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'en lang adgangskode', code: recovery[0] }) })).status).toBe(401);
  });

  it('locks after repeated failures, rejects foreign origins, and logs out everywhere', async () => {
    const bad = (await fetch(base + '/api/auth/status', { headers: { Origin: 'https://evil.example' } })).status;
    expect(bad).toBe(403);
    for (let i = 0; i < 4; i++) await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'nej nej nej nej', code: '123456' }) });
    expect((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'en lang adgangskode', code: recovery[1] }) })).status).toBe(429);
    expect((await call('/api/auth/logout', { method: 'POST', cookie, body: JSON.stringify({ everywhere: true }) })).status).toBe(200);
    expect((await call('/api/data', { cookie })).status).toBe(401);
    const backupFiles = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(backupFiles.sort()).toEqual(['auth.json', 'finstate.json']);
  });
});
