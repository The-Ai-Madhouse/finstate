/**
 * Finstate som selvstændig server (fx på en Raspberry Pi): viser den byggede app (dist/) og API'et med login og kryptering.
 *
 *   npm run build && npm run serve
 *
 * Miljø:
 *   FINSTATE_DIR            datamappe (standard ~/Documents/Finstate)
 *   PORT / HOST             standard 5173 / 127.0.0.1 – lyt KUN lokalt; Caddy på Pi'en giver HTTPS på hjemmenetværket
 *   FINSTATE_ALLOWED_HOSTS  fx "finstate.local" (navnet, du åbner siden med)
 *   FINSTATE_LOGIN          on (standard her) | off – login med adgangskode + 2FA
 *
 * Kun hjemmenetværket: forespørgsler fra en offentlig IP-adresse afvises altid (se server/net.ts).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler, loginRequired } from './storage.ts';
import { fromHomeNetwork } from './net.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** Sikkerheds-headers på alt: ingen indlejring, ingen eksterne kilder, ingen henvisninger ud af siden. */
function secure(res: ServerResponse) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist + sep) && file !== dist) { res.statusCode = 400; return res.end(); }
  const isFile = await stat(file).then((s) => s.isFile(), () => false);
  if (!isFile) file = join(dist, 'index.html'); // én side – alle stier viser appen
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    // Filer med hash i navnet kan caches længe; index.html altid frisk.
    res.setHeader('Cache-Control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Byg appen først: npm run build');
  }
}

// På netværket: altid login med adgangskode + 2FA (FINSTATE_LOGIN=off slår det kun fra for 127.0.0.1/localhost).
const api = handler(root, { requireLogin: loginRequired(true) });
createServer((req, res) => {
  secure(res);
  // Kun dit eget netværk – aldrig udefra, heller ikke hvis en port ved en fejl åbnes i routeren.
  if (!fromHomeNetwork(req)) { res.statusCode = 403; return res.end('Finstate kan kun bruges fra hjemmenetværket.'); }
  void api(req, res, () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    void serveStatic(req, res);
  });
}).listen(PORT, HOST, () => {
  console.log(`Finstate kører på http://${HOST}:${PORT}  ·  data: ${process.env.FINSTATE_DIR ?? '~/Documents/Finstate'}`);
});
