/**
 * Kun hjemmenetværket: Finstate svarer kun klienter med en privat (lokal) IP-adresse.
 * Kommer en forespørgsel nogensinde udefra (fx hvis routeren ved en fejl videresender en port), afvises den.
 */
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

/** Private/lokale adresser: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 (link-local), ::1, fe80::/10, fc00::/7. */
export function isPrivateIp(raw: string | undefined): boolean {
  if (!raw) return false;
  let ip = raw.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::1') return true;
    const first = parseInt(x.split(':')[0] || '0', 16);
    return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
  }
  return false;
}

/**
 * Klientens adresse. Står der en proxy på selve Pi'en foran (Caddy på 127.0.0.1), er den rigtige klient
 * den sidste adresse i X-Forwarded-For (Caddy sætter den selv og stoler ikke på, hvad klienten sender).
 */
export function clientIp(req: IncomingMessage): string | undefined {
  const direct = req.socket.remoteAddress;
  const loopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  const xff = req.headers['x-forwarded-for'];
  if (loopback && xff) {
    const list = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((s) => s.trim()).filter(Boolean);
    return list[list.length - 1];
  }
  return direct;
}

export const fromHomeNetwork = (req: IncomingMessage) => isPrivateIp(clientIp(req));
