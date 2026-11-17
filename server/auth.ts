/**
 * Login med 2FA for Finstate (én bruger).
 *
 * auth.json indeholder ingen hemmeligheder i klartekst:
 *  · datanøglen (DEK) er krypteret med en nøgle fra adgangskoden – og pr. login med en nøgle fra login-billetten
 *  · 2FA-hemmeligheden er krypteret med datanøglen
 *  · gendannelseskoder og login-billetter ligger kun som SHA-256
 * Uden adgangskoden (eller et gyldigt login fra en browser) kan data ikke læses – heller ikke fra en stjålet disk.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { newDataKey, newKdf, newTotpSecret, open, passwordKey, randomTicket, safeEqual, seal, sessionKey, sha256, verifyTotp, type KdfParams, type Sealed } from './crypto.ts';

export const SESSION_DAYS = 28;
const MAX_SESSIONS = 20;

interface Session { id: string; createdAt: string; expiresAt: string; label?: string; dek: Sealed }
export interface AuthFile {
  version: 1;
  createdAt: string;
  kdf: KdfParams;
  /** Datanøglen krypteret med adgangskodens nøgle. */
  dekByPassword: Sealed;
  /** 2FA-hemmeligheden krypteret med datanøglen. */
  totp: Sealed;
  lastTotpCounter?: number;
  recovery: string[];
  sessions: Session[];
  failures?: { count: number; lockedUntil?: string };
}

export class AuthError extends Error {
  status: number;
  retryAfter?: number;
  constructor(message: string, status = 401, retryAfter?: number) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const newRecoveryCodes = () => Array.from({ length: 10 }, () => randomTicket(8).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(10, 'x').slice(0, 10).replace(/(.{5})/, '$1-'));
const normRecovery = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Opsætning i gang: adgangskode valgt, venter på første 2FA-kode (kun i hukommelsen, aldrig på disk). */
interface PendingSetup { kdf: KdfParams; dek: Buffer; dekByPassword: Sealed; secret: string; expires: number }

export class Auth {
  private pending = new Map<string, PendingSetup>();
  private dir: string;
  private write: (file: string, text: string) => Promise<void>;
  constructor(dir: string, write: (file: string, text: string) => Promise<void>) { this.dir = dir; this.write = write; }

  get file() { return join(this.dir, 'auth.json'); }
  async configured() { return exists(this.file); }
  async load(): Promise<AuthFile | undefined> {
    if (!(await this.configured())) return undefined;
    return JSON.parse(await readFile(this.file, 'utf8')) as AuthFile;
  }
  private save(a: AuthFile) { return this.write(this.file, JSON.stringify(a, null, 2)); }

  /** Trin 1: vælg adgangskode → få en 2FA-hemmelighed at scanne. */
  async setupStart(password: string) {
    if (await this.configured()) throw new AuthError('Login er allerede sat op.', 409);
    if (password.length < 10) throw new AuthError('Adgangskoden skal være mindst 10 tegn.', 400);
    const kdf = newKdf();
    const dek = newDataKey();
    const dekByPassword = seal(passwordKey(password, kdf), dek, 'dek');
    const secret = newTotpSecret();
    const ticket = randomTicket();
    this.pending.set(ticket, { kdf, dek, dekByPassword, secret, expires: Date.now() + 15 * 60_000 });
    return { setupTicket: ticket, secret };
  }

  /** Trin 2: bekræft med en kode fra appen → login gemmes, og man er logget ind. */
  async setupFinish(setupTicket: string, code: string, label?: string) {
    const p = this.pending.get(setupTicket);
    if (!p || p.expires < Date.now()) throw new AuthError('Opsætningen er udløbet – start forfra.', 400);
    const counter = verifyTotp(p.secret, code);
    if (counter === undefined) throw new AuthError('Koden passer ikke – tjek at uret på telefonen er rigtigt, og prøv den næste kode.', 400);
    if (await this.configured()) throw new AuthError('Login er allerede sat op.', 409);
    const recovery = newRecoveryCodes();
    const a: AuthFile = {
      version: 1, createdAt: new Date().toISOString(), kdf: p.kdf, dekByPassword: p.dekByPassword,
      totp: seal(p.dek, Buffer.from(p.secret), 'totp'), lastTotpCounter: counter,
      recovery: recovery.map((c) => sha256(normRecovery(c))), sessions: [],
    };
    this.pending.delete(setupTicket);
    const session = this.addSession(a, p.dek, label);
    await this.save(a);
    return { dek: p.dek, recovery, ...session };
  }

  private addSession(a: AuthFile, dek: Buffer, label?: string) {
    const ticket = randomTicket();
    const now = Date.now();
    a.sessions = a.sessions.filter((s) => Date.parse(s.expiresAt) > now).slice(-(MAX_SESSIONS - 1));
    a.sessions.push({ id: sha256(ticket), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_DAYS * 86_400_000).toISOString(), label, dek: seal(sessionKey(ticket), dek, 'session') });
    return { ticket, expiresAt: a.sessions[a.sessions.length - 1].expiresAt };
  }

  /** Log ind: adgangskode + kode fra appen (eller en gendannelseskode). */
  async login(password: string, code: string, label?: string) {
    const a = await this.load();
    if (!a) throw new AuthError('Login er ikke sat op endnu.', 409);
    const locked = a.failures?.lockedUntil ? Date.parse(a.failures.lockedUntil) - Date.now() : 0;
    if (locked > 0) throw new AuthError(`For mange forkerte forsøg – prøv igen om ${Math.ceil(locked / 60_000)} min.`, 429, Math.ceil(locked / 1000));
    const fail = async (msg: string) => {
      const count = (a.failures?.count ?? 0) + 1;
      // Efter 5 forkerte forsøg: spærret i 1, 2, 4 … minutter (højst 1 time).
      const lock = count >= 5 ? Math.min(60, 2 ** (count - 5)) * 60_000 : 0;
      a.failures = { count, lockedUntil: lock ? new Date(Date.now() + lock).toISOString() : undefined };
      await this.save(a);
      throw new AuthError(msg);
    };
    let dek: Buffer;
    try { dek = open(passwordKey(password, a.kdf), a.dekByPassword, 'dek'); } catch { return fail('Forkert adgangskode eller kode.'); }
    const c = code.trim();
    const recoveryHash = sha256(normRecovery(c));
    const ri = a.recovery.findIndex((h) => safeEqual(h, recoveryHash));
    if (/^\d{6}$/.test(c.replace(/\s/g, ''))) {
      const secret = open(dek, a.totp, 'totp').toString();
      const counter = verifyTotp(secret, c);
      if (counter === undefined || counter <= (a.lastTotpCounter ?? -1)) return fail('Forkert adgangskode eller kode.');
      a.lastTotpCounter = counter;
    } else if (ri >= 0) {
      a.recovery.splice(ri, 1); // en gendannelseskode kan kun bruges én gang
    } else return fail('Forkert adgangskode eller kode.');
    a.failures = undefined;
    const session = this.addSession(a, dek, label);
    await this.save(a);
    return { ...session, recoveryLeft: a.recovery.length };
  }

  /** Datanøglen for et login – eller undefined, hvis det er ugyldigt/udløbet. */
  async unlock(ticket?: string): Promise<{ dek: Buffer; expiresAt: string } | undefined> {
    if (!ticket) return undefined;
    const a = await this.load();
    const s = a?.sessions.find((x) => safeEqual(x.id, sha256(ticket)));
    if (!s || Date.parse(s.expiresAt) < Date.now()) return undefined;
    try { return { dek: open(sessionKey(ticket), s.dek, 'session'), expiresAt: s.expiresAt }; } catch { return undefined; }
  }

  async logout(ticket: string, everywhere = false) {
    const a = await this.load();
    if (!a) return;
    a.sessions = everywhere ? [] : a.sessions.filter((s) => !safeEqual(s.id, sha256(ticket)));
    await this.save(a);
  }

  /** Nye gendannelseskoder (de gamle holder op med at virke). */
  async newRecovery() {
    const a = await this.load();
    if (!a) throw new AuthError('Login er ikke sat op.', 409);
    const codes = newRecoveryCodes();
    a.recovery = codes.map((c) => sha256(normRecovery(c)));
    await this.save(a);
    return codes;
  }

  async status(ticket?: string) {
    const a = await this.load();
    const u = a ? await this.unlock(ticket) : undefined;
    return { configured: !!a, loggedIn: !!u, expiresAt: u?.expiresAt, recoveryLeft: u ? a!.recovery.length : undefined, sessions: u ? a!.sessions.filter((s) => Date.parse(s.expiresAt) > Date.now()).length : undefined };
  }
}

