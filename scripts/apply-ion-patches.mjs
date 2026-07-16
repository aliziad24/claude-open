#!/usr/bin/env node

// Transactionally applies the small renderer changes required by Claude Open.
// The signed executable and app.asar are never modified. Hashed chunk filenames
// are discovered by content so official point releases do not require hardcoded
// asset names; every signature must still match exactly once or nothing is kept.

import { copyFile, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';

const [targetApp, widgetSource] = process.argv.slice(2);
if (!targetApp || !widgetSource) {
  throw new Error('usage: node apply-ion-patches.mjs <target-app-dir> <z-usage-widget.js>');
}

const ion = path.join(targetApp, 'resources', 'ion-dist');
const assets = path.join(ion, 'assets', 'v1');
const planned = new Map();
const originals = new Map();

async function javascriptFiles(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await javascriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(full);
  }
  return output;
}

async function uniqueFileContaining(needle, label) {
  const hits = [];
  for (const file of await javascriptFiles(assets)) {
    const current = planned.has(file) ? planned.get(file) : await readFile(file, 'utf8');
    if (current.includes(needle)) hits.push(file);
  }
  if (hits.length !== 1) throw new Error(`${label}: expected one matching chunk, found ${hits.length}`);
  return hits[0];
}

async function replaceOnce(file, find, replacement, label) {
  const current = planned.has(file) ? planned.get(file) : await readFile(file, 'utf8');
  if (!originals.has(file)) originals.set(file, current);
  const count = current.split(find).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one stock match, found ${count}`);
  planned.set(file, current.replace(find, replacement));
  process.stdout.write(`[patch] ${label}\n`);
}

await replaceOnce(
  path.join(ion, 'index.html'),
  '</body>',
  '<script src="/assets/v1/z-usage-widget.js"></script></body>',
  'usage widget script tag',
);

const coworkUnsupported = 'return"unsupported"===i.status&&i.unsupportedCode?n.push({key:"task",label:"Cowork",ariaLabel:"Cowork",disabled:!0,unsupportedCode:i.unsupportedCode,unsupportedReason:i.localizedUnsupportedStringFromDesktop})';
const coworkUnavailable = ':"unavailable"===i.status?n.push({key:"task",label:"Cowork",ariaLabel:"Cowork",disabled:!0,unsupportedCode:"desktop_update_needed"})';
const coworkChunk = await uniqueFileContaining(coworkUnsupported, 'Cowork gate chunk');
await replaceOnce(
  coworkChunk,
  coworkUnsupported,
  'return!1&&"unsupported"===i.status&&i.unsupportedCode?n.push({key:"task",label:"Cowork",ariaLabel:"Cowork",disabled:!0,unsupportedCode:i.unsupportedCode,unsupportedReason:i.localizedUnsupportedStringFromDesktop})',
  'Cowork unsupported gate',
);
await replaceOnce(
  coworkChunk,
  coworkUnavailable,
  ':!1&&"unavailable"===i.status?n.push({key:"task",label:"Cowork",ariaLabel:"Cowork",disabled:!0,unsupportedCode:"desktop_update_needed"})',
  'Cowork unavailable gate',
);

const sshAvailability = 'const t=!1,[s,n]=e.useState([]),[a,i]=e.useState(!0),r=e.useCallback(()=>Xk().then(e=>(n(t=>JSON.stringify(t)===JSON.stringify(e)?t:e),i(!0),e)),[])';
const sshChunk = await uniqueFileContaining(sshAvailability, 'SSH chunk');
await replaceOnce(
  sshChunk,
  sshAvailability,
  'const t=!0,[s,n]=e.useState([]),[a,i]=e.useState(!0),r=e.useCallback(()=>Xk().then(e=>(n(t=>JSON.stringify(t)===JSON.stringify(e)?t:e),i(!0),e)),[])',
  'SSH availability',
);
await replaceOnce(
  sshChunk,
  'return e.useEffect(()=>{},[t,r]),{sshConfigs:s,sshConfigsLoaded:a,sshApisAvailable:t,refresh:r}',
  'return e.useEffect(()=>{t&&r()},[t,r]),{sshConfigs:s,sshConfigsLoaded:a,sshApisAvailable:t,refresh:r}',
  'SSH loader',
);
await replaceOnce(
  sshChunk,
  'Zn=e.useMemo(()=>[],[M,w,x,Cs,i,Un])',
  'Zn=e.useMemo(()=>M?w.map(c=>({config:c,checked:(_?.id===c.id),onSelect:()=>zs(c.id),label:c.name||c.sshHost})):[],[M,w,_,zs])',
  'SSH picker items',
);

// No installed file changes until every release signature has been validated.
const widgetTarget = path.join(assets, 'z-usage-widget.js');
const patchRecord = path.join(assets, 'claude-open-patches.json');
let widgetOriginal = null;
try { widgetOriginal = await readFile(widgetTarget); } catch {}
try {
  await copyFile(widgetSource, widgetTarget);
  for (const [file, contents] of planned) await writeFile(file, contents, 'utf8');
  await writeFile(patchRecord, JSON.stringify({ schemaVersion: 1, patches: ['usage-widget', 'cowork-gates', 'ssh-manager'] }, null, 2));
  process.stdout.write('[patch] all ion-dist patches applied\n');
} catch (error) {
  for (const [file, contents] of originals) await writeFile(file, contents, 'utf8');
  if (widgetOriginal) await writeFile(widgetTarget, widgetOriginal);
  else await rm(widgetTarget, { force: true });
  await rm(patchRecord, { force: true });
  throw error;
}
