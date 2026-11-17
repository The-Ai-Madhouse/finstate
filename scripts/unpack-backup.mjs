#!/usr/bin/env node
/**
 * Pak en krypteret Finstate-backup (downloadet under Indstillinger → Backup & data) ud til en mappe.
 * Indholdet forbliver krypteret – åbn det med samme adgangskode og 2FA:
 *
 *   node scripts/unpack-backup.mjs finstate-krypteret-backup-2026-11-17.json ~/Documents/FinstateBackup
 *   FINSTATE_DIR=~/Documents/FinstateBackup npm start
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, normalize, sep } from 'node:path';
import { homedir } from 'node:os';

const [file, target] = process.argv.slice(2);
if (!file || !target) {
  console.error('Brug: node scripts/unpack-backup.mjs <backup.json> <mappe>');
  process.exit(1);
}
const dir = resolve(target.replace(/^~(?=$|\/)/, homedir()));
const b = JSON.parse(await readFile(file, 'utf8'));
if (b.format !== 'finstate-encrypted-backup') { console.error('Det er ikke en krypteret Finstate-backup.'); process.exit(1); }
if (await stat(join(dir, 'auth.json')).then(() => true, () => false)) {
  console.error(`${dir} indeholder allerede Finstate-data – vælg en tom mappe, så intet overskrives.`);
  process.exit(1);
}
for (const [name, text] of Object.entries(b.files)) {
  const out = normalize(join(dir, name));
  if (!out.startsWith(dir + sep)) throw new Error(`Ugyldigt filnavn i backuppen: ${name}`);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, text, { mode: 0o600 });
}
console.log(`Pakket ${Object.keys(b.files).length} filer ud i ${dir} (stadig krypteret).`);
console.log(`Åbn med: FINSTATE_DIR=${dir} npm start`);
