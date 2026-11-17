/**
 * Kryptografi til Finstate – kun Node's indbyggede crypto (ingen eksterne afhængigheder):
 *  · AES-256-GCM til data og versioner (autentificeret: ændrede eller forfalskede filer opdages)
 *  · scrypt til at udlede en nøgle fra adgangskoden
 *  · HKDF til at udlede en nøgle fra et login (så et gyldigt login kan låse data op – også efter genstart)
 *  · TOTP (RFC 6238) til 2FA-koder fra en app
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');

export interface Sealed { iv: string; tag: string; ct: string }

/** Krypter med AES-256-GCM. aad binder indholdet til sin plads (fx "data" eller en versions id), så filer ikke kan byttes rundt. */
export function seal(key: Buffer, plain: Buffer, aad: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), ct: b64(ct) };
}

/** Dekrypter – kaster en fejl, hvis nøglen er forkert, eller indholdet er ændret. */
export function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, unb64(s.iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(unb64(s.tag));
  return Buffer.concat([d.update(unb64(s.ct)), d.final()]);
}

export interface KdfParams { salt: string; N: number; r: number; p: number }
export const newKdf = (): KdfParams => ({ salt: b64(randomBytes(16)), N: 2 ** 15, r: 8, p: 1 });
/** Nøgle fra adgangskoden (scrypt – bevidst langsom, så gæt er dyre). */
export const passwordKey = (password: string, k: KdfParams) =>
  scryptSync(password.normalize('NFKC'), unb64(k.salt), 32, { N: k.N, r: k.r, p: k.p, maxmem: 128 * 1024 * 1024 });

/** Nøgle fra et login-billet (billetten ligger kun i browserens cookie – aldrig på disken). */
export const sessionKey = (ticket: string) => Buffer.from(hkdfSync('sha256', Buffer.from(ticket, 'base64url'), Buffer.alloc(0), 'finstate-session-key', 32));

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomTicket = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const newDataKey = () => randomBytes(32);

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ TOTP (RFC 6238)

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHA.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

/** 6-cifret kode for et tidstrin (30 sek.). */
export function totpAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const totpCounter = (ms = Date.now()) => Math.floor(ms / 1000 / 30);

/** Tjek en kode (tillader ét tidstrin før/efter for ur-forskel). Giver tidstrinnet tilbage, så samme kode ikke kan bruges igen. */
export function verifyTotp(secret: string, code: string, ms = Date.now()): number | undefined {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return undefined;
  const now = totpCounter(ms);
  for (const k of [now, now - 1, now + 1]) if (safeEqual(totpAt(secret, k), c)) return k;
  return undefined;
}

export const otpauthUri = (secret: string, label = 'Finstate') =>
  `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=Finstate&algorithm=SHA1&digits=6&period=30`;
