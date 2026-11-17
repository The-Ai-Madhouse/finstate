/**
 * Lokal lagring for Finstate: gemmer data i en fil på din computer i stedet for (kun) i browseren.
 *
 *  · Mappe: $FINSTATE_DIR eller ~/Documents/Finstate – altid UDEN FOR projektet, så data aldrig kan havne i git.
 *  · finstate.json skrives atomisk (midlertidig fil + omdøbning); forrige udgave gemmes som finstate.json.bak.
 *  · versions/<id>.json: navngivne versioner (milepæle), som man kan sammenligne med og gå tilbage til.
 *  · Kun Finstates egen side må bruge den: serveren lytter på 127.0.0.1, og Host/Origin skal være 127.0.0.1/localhost.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { Plugin } from 'vite';

const MAX_BODY = 200 * 1024 * 1024;

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
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const send = (res: ServerResponse, code: number, body: unknown) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** Kun Finstate selv: anden Host/Origin (fx en fremmed hjemmeside eller DNS-rebinding) afvises. */
function allowed(req: IncomingMessage): boolean {
  const okHost = (h?: string) => !!h && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);
  if (!okHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (!okHost(new URL(origin).host)) return false; } catch { return false; }
  }
  return true;
}

const safeId = (id: string) => /^[a-z0-9-]{1,80}$/.test(id);

function handler(root: string) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) return next();
    if (!allowed(req)) return send(res, 403, { error: 'Kun Finstate selv har adgang.' });
    let dir: string;
    try { dir = storageDir(root); } catch (e) { return send(res, 500, { error: (e as Error).message }); }
    const dataFile = join(dir, 'finstate.json');
    const vdir = join(dir, 'versions');
    try {
      // Hvor gemmes der – og findes filen?
      if (url.pathname === '/api/storage' && req.method === 'GET') {
        const has = await exists(dataFile);
        const st = has ? await stat(dataFile) : undefined;
        return send(res, 200, { dir: pretty(dir), exists: has, savedAt: st?.mtime.toISOString() });
      }
      if (url.pathname === '/api/data') {
        if (req.method === 'GET') {
          if (!(await exists(dataFile))) return send(res, 404, { error: 'Ingen datafil endnu' });
          return send(res, 200, await readFile(dataFile, 'utf8'));
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = await readBody(req);
          JSON.parse(body); // gem aldrig noget, der ikke er gyldig JSON
          await mkdir(dir, { recursive: true });
          if (await exists(dataFile)) await copyFile(dataFile, `${dataFile}.bak`);
          await writeAtomic(dataFile, body);
          return send(res, 200, { ok: true, savedAt: new Date().toISOString() });
        }
      }
      if (url.pathname === '/api/versions') {
        if (req.method === 'GET') {
          await mkdir(vdir, { recursive: true });
          const files = (await readdir(vdir)).filter((f) => f.endsWith('.json'));
          const metas = await Promise.all(files.map(async (f) => {
            const v = JSON.parse(await readFile(join(vdir, f), 'utf8')) as Record<string, unknown>;
            const { data: _d, ...meta } = v; void _d;
            return meta;
          }));
          return send(res, 200, metas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
        }
        if (req.method === 'POST') {
          const v = JSON.parse(await readBody(req)) as { id?: string };
          if (!v.id || !safeId(v.id)) return send(res, 400, { error: 'Ugyldigt id' });
          await mkdir(vdir, { recursive: true });
          await writeAtomic(join(vdir, `${v.id}.json`), JSON.stringify(v));
          return send(res, 200, { ok: true });
        }
      }
      const m = url.pathname.match(/^\/api\/versions\/([^/]+)$/);
      if (m && safeId(m[1])) {
        const f = join(vdir, `${m[1]}.json`);
        if (!(await exists(f))) return send(res, 404, { error: 'Versionen findes ikke' });
        if (req.method === 'GET') return send(res, 200, await readFile(f, 'utf8'));
        if (req.method === 'DELETE') { await rm(f); return send(res, 200, { ok: true }); }
        if (req.method === 'PATCH') {
          const patch = JSON.parse(await readBody(req)) as { name?: string; note?: string };
          const v = JSON.parse(await readFile(f, 'utf8')) as Record<string, unknown>;
          if (typeof patch.name === 'string' && patch.name.trim()) v.name = patch.name.trim();
          if (typeof patch.note === 'string') v.note = patch.note;
          await writeAtomic(f, JSON.stringify(v));
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'Ukendt' });
    } catch (e) {
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
