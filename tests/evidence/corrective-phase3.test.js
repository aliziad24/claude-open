// Corrective Phase 3 (Gate P0.3) — reusable-logic + shim contract tests.
//
// Two units are proven here without launching Claude or touching a real gateway:
//
//   1. scripts/lib/adapter-requests.mjs — parses the adapter's stdout NDJSON
//      'request' events into SANITIZED counters (method+path only; query string,
//      headers, and bodies are never retained). This is the exact logic the
//      PowerShell 5.1 runner (Invoke-CorrectivePhase3.ps1) uses to decide whether
//      the CLIENT emitted GET /v1/models and POST /v1/messages.
//
//   2. scripts/write-3p-config.mjs — a tiny node CLI shim that REUSES the repaired
//      @claude-open/identity-harness createCandidateWorkspace to write the exact
//      FLAT config-library contract into a disposable CLAUDE_USER_DATA_DIR. It
//      must match the sanitized fixture shape captured from Claude 1.20186.1.
//
// A fixture/serialization test can never earn P0.3 PASS (that requires the real
// client). These only guard the reusable pieces the live runner depends on.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseRequestEvents,
  countRequests,
  clientDroveModels,
  clientDroveMessages,
  filterClientOriginated,
} from '../../scripts/lib/adapter-requests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'claude-3p-config');
const FIXTURE_UUID = '00000000-0000-0000-0000-000000000000';
const SHIM = path.join(ROOT, 'scripts', 'write-3p-config.mjs');

// Word-delimited placeholder — never a real secret, and shaped so the release
// privacy scanner does not flag it.
const TOKEN = 'ephemeral-loopback-token-TEST-0123456789';

// ---------------------------------------------------------------------------
// 1. Reusable request-counter parser
// ---------------------------------------------------------------------------

// A realistic slice of adapter stdout: NDJSON lines, some request events with
// query strings/secrets in the path that must be stripped, plus non-request
// noise the parser must ignore.
const SAMPLE_STDOUT = [
  JSON.stringify({ t: '2026-07-12T00:00:00.000Z', evt: 'listening', port: 51515 }),
  JSON.stringify({ t: '2026-07-12T00:00:01.000Z', evt: 'request', method: 'GET', path: '/health' }),
  JSON.stringify({ t: '2026-07-12T00:00:02.000Z', evt: 'request', method: 'GET', path: '/health/deep' }),
  JSON.stringify({ t: '2026-07-12T00:00:03.000Z', evt: 'request', method: 'GET', path: '/v1/models' }),
  JSON.stringify({ t: '2026-07-12T00:00:04.000Z', evt: 'request', method: 'GET', path: '/v1/models' }),
  'not json at all — must be skipped',
  JSON.stringify({ t: '2026-07-12T00:00:05.000Z', evt: 'messages', model: 'x', status: 200 }),
  JSON.stringify({ t: '2026-07-12T00:00:06.000Z', evt: 'request', method: 'POST', path: '/v1/messages' }),
  '',
].join('\n');

test('parseRequestEvents: extracts only request events as method+path(+t), no query/body', () => {
  const events = parseRequestEvents(SAMPLE_STDOUT);
  assert.deepEqual(events.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/health/deep' },
    { method: 'GET', path: '/v1/models' },
    { method: 'GET', path: '/v1/models' },
    { method: 'POST', path: '/v1/messages' },
  ]);
  // No headers/bodies ever surface — only method, path, and the timestamp.
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), ['method', 'path', 't']);
  }
});

test('parseRequestEvents: strips any query string from the recorded path', () => {
  const line = JSON.stringify({ evt: 'request', method: 'GET', path: '/v1/models?limit=1000&secret=abc' });
  const events = parseRequestEvents(line);
  assert.deepEqual(events.map(({ method, path }) => ({ method, path })), [{ method: 'GET', path: '/v1/models' }]);
  // The retained path must not carry the query fragment at all.
  assert.ok(!JSON.stringify(events).includes('secret'));
  assert.ok(!JSON.stringify(events).includes('limit=1000'));
});

test('countRequests: produces sanitized "METHOD path" -> count counters', () => {
  const counters = countRequests(parseRequestEvents(SAMPLE_STDOUT));
  assert.equal(counters['GET /v1/models'], 2);
  assert.equal(counters['POST /v1/messages'], 1);
  assert.equal(counters['GET /health'], 1);
  assert.equal(counters['GET /health/deep'], 1);
});

test('clientDroveModels / clientDroveMessages reflect the presence of client-originated calls', () => {
  const events = parseRequestEvents(SAMPLE_STDOUT);
  assert.equal(clientDroveModels(events), true);
  assert.equal(clientDroveMessages(events), true);

  const noMessages = parseRequestEvents([
    JSON.stringify({ evt: 'request', method: 'GET', path: '/v1/models' }),
  ].join('\n'));
  assert.equal(clientDroveModels(noMessages), true);
  assert.equal(clientDroveMessages(noMessages), false);
});

test('parseRequestEvents: tolerates CRLF line endings (PowerShell-captured stdout)', () => {
  const crlf = SAMPLE_STDOUT.replaceAll('\n', '\r\n');
  assert.deepEqual(parseRequestEvents(crlf), parseRequestEvents(SAMPLE_STDOUT));
});

test('parseRequestEvents: retains the event timestamp for origin windowing', () => {
  const line = JSON.stringify({ t: '2026-07-12T00:00:03.000Z', evt: 'request', method: 'GET', path: '/v1/models' });
  const [event] = parseRequestEvents(line);
  assert.equal(event.t, '2026-07-12T00:00:03.000Z');
});

// filterClientOriginated is the anti-conflation guard: it excludes any request
// whose timestamp falls in a runner-owned window (the setup /health/deep +
// /v1/models probe BEFORE the client launched, and the loopback proof AFTER the
// client window). Only requests strictly inside [clientLaunchUtc, loopbackStartUtc)
// can be client-originated. This is what stops the runner's own POST /v1/messages
// loopback proof from being miscounted as a client message.
test('filterClientOriginated: excludes runner setup and loopback-proof requests by time window', () => {
  const events = [
    { method: 'GET', path: '/health/deep', t: '2026-07-12T00:00:00.000Z' }, // runner setup
    { method: 'GET', path: '/v1/models', t: '2026-07-12T00:00:01.000Z' },   // runner setup probe
    { method: 'GET', path: '/v1/models', t: '2026-07-12T00:00:05.000Z' },   // client
    { method: 'POST', path: '/v1/messages', t: '2026-07-12T00:00:06.000Z' }, // client
    { method: 'GET', path: '/usage', t: '2026-07-12T00:00:20.000Z' },        // loopback proof
    { method: 'POST', path: '/v1/messages', t: '2026-07-12T00:00:21.000Z' }, // loopback proof
  ];
  const clientEvents = filterClientOriginated(events, {
    clientLaunchUtc: '2026-07-12T00:00:04.000Z',
    loopbackStartUtc: '2026-07-12T00:00:19.000Z',
  });
  assert.deepEqual(clientEvents, [
    { method: 'GET', path: '/v1/models', t: '2026-07-12T00:00:05.000Z' },
    { method: 'POST', path: '/v1/messages', t: '2026-07-12T00:00:06.000Z' },
  ]);
  assert.equal(clientDroveModels(clientEvents), true);
  assert.equal(clientDroveMessages(clientEvents), true);
});

test('filterClientOriginated: with NO client window, loopback-only traffic is not client-originated', () => {
  const events = [
    { method: 'GET', path: '/health/deep', t: '2026-07-12T00:00:00.000Z' },
    { method: 'GET', path: '/v1/models', t: '2026-07-12T00:00:01.000Z' },
    { method: 'POST', path: '/v1/messages', t: '2026-07-12T00:00:21.000Z' }, // loopback proof only
  ];
  const clientEvents = filterClientOriginated(events, {
    clientLaunchUtc: '2026-07-12T00:00:10.000Z',
    loopbackStartUtc: '2026-07-12T00:00:20.000Z',
  });
  assert.equal(clientDroveMessages(clientEvents), false);
  assert.equal(clientDroveModels(clientEvents), false);
});

test('filterClientOriginated: a client message that occurs is kept even if the client got an error', () => {
  // Origin windowing is about WHO sent it, not whether it succeeded. Success /
  // rendered-response is judged separately by the runner from the client log.
  const events = [
    { method: 'POST', path: '/v1/messages', t: '2026-07-12T00:00:06.000Z' },
  ];
  const clientEvents = filterClientOriginated(events, {
    clientLaunchUtc: '2026-07-12T00:00:04.000Z',
    loopbackStartUtc: '2026-07-12T00:00:19.000Z',
  });
  assert.equal(clientDroveMessages(clientEvents), true);
});

// ---------------------------------------------------------------------------
// 2. node shim reuses the harness and writes the exact FLAT contract
// ---------------------------------------------------------------------------

async function runShim(args, cwd) {
  return spawnSync(process.execPath, [SHIM, ...args], { cwd, encoding: 'utf8' });
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'co-phase3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeGate(root, status) {
  const gate = path.join(root, 'run.json');
  await writeFile(gate, JSON.stringify({ p0_0: { status } }), 'utf8');
  return gate;
}

function modelsFixtureFile(dir, models) {
  return writeFile(path.join(dir, 'models.json'), JSON.stringify(models), 'utf8');
}

const THREE_MODELS = [
  { id: 'claude-opus-4', display_name: 'Claude Opus 4 (Loopback)' },
  { id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4 (Loopback)' },
  { id: 'claude-haiku-4', display_name: 'Claude Haiku 4 (Loopback)' },
];

test('shim writes the exact FLAT config-library contract matching the 1.20186.1 fixture', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const userData = path.join(root, 'profile-B');
  const harnessRoot = path.join(root, 'harness');
  const modelsFile = path.join(root, 'models.json');
  await modelsFixtureFile(root, THREE_MODELS);

  const res = await runShim([
    '--candidate', 'B',
    '--gate', gate,
    '--harness-root', harnessRoot,
    '--user-data', userData,
    '--base-url', 'http://127.0.0.1:51515',
    '--token', TOKEN,
    '--models', modelsFile,
    '--config-name', 'Claude Open Gateway',
  ], root);

  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  const config = JSON.parse(await readFile(out.paths.configuration, 'utf8'));
  const fixture = JSON.parse(await readFile(path.join(FIXTURE_DIR, `${FIXTURE_UUID}.json`), 'utf8'));

  // Same flat key set as the real fixture — no nested inference{} / models.list.
  assert.deepEqual(Object.keys(config).sort(), Object.keys(fixture).sort());
  assert.equal(config.inference, undefined);
  assert.equal(config.models, undefined);
  assert.equal(config.inferenceProvider, 'gateway');
  assert.equal(config.inferenceGatewayBaseUrl, 'http://127.0.0.1:51515');
  assert.equal(config.inferenceGatewayApiKey, TOKEN);
  assert.equal(config.inferenceCredentialKind, 'static');
  assert.equal(config.inferenceGatewayAuthScheme, 'bearer');
  assert.equal(config.modelDiscoveryEnabled, false);

  // All models present, default FIRST, name==id, labelOverride==display_name.
  assert.equal(config.inferenceModels.length, THREE_MODELS.length);
  assert.deepEqual(config.inferenceModels[0], {
    name: 'claude-opus-4',
    labelOverride: 'Claude Opus 4 (Loopback)',
  });
  assert.equal(config.inferenceModels[0].name, THREE_MODELS[0].id);
});

test('shim honours --default to place the chosen alias first', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const modelsFile = path.join(root, 'models.json');
  await modelsFixtureFile(root, THREE_MODELS);

  const res = await runShim([
    '--candidate', 'B',
    '--gate', gate,
    '--harness-root', path.join(root, 'harness'),
    '--user-data', path.join(root, 'profile-B'),
    '--base-url', 'http://127.0.0.1:51515',
    '--token', TOKEN,
    '--models', modelsFile,
    '--default', 'claude-sonnet-4',
  ], root);

  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);
  const config = JSON.parse(await readFile(out.paths.configuration, 'utf8'));
  assert.equal(config.inferenceModels[0].name, 'claude-sonnet-4');
  // The other models are still present exactly once.
  const names = config.inferenceModels.map((m) => m.name);
  assert.equal(new Set(names).size, THREE_MODELS.length);
});

test('shim writes deploymentMode 3p only in claude_desktop_config.json, never in the config-library file', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const userData = path.join(root, 'profile-B');
  const modelsFile = path.join(root, 'models.json');
  await modelsFixtureFile(root, THREE_MODELS);

  const res = await runShim([
    '--candidate', 'B',
    '--gate', gate,
    '--harness-root', path.join(root, 'harness'),
    '--user-data', userData,
    '--base-url', 'http://127.0.0.1:51515',
    '--token', TOKEN,
    '--models', modelsFile,
  ], root);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const out = JSON.parse(res.stdout);

  const prefs = JSON.parse(await readFile(out.paths.preferences, 'utf8'));
  assert.equal(prefs.deploymentMode, '3p');
  const config = JSON.parse(await readFile(out.paths.configuration, 'utf8'));
  assert.equal(config.deploymentMode, undefined);
});

test('shim output never prints the ephemeral loopback token', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const modelsFile = path.join(root, 'models.json');
  await modelsFixtureFile(root, THREE_MODELS);

  const res = await runShim([
    '--candidate', 'B',
    '--gate', gate,
    '--harness-root', path.join(root, 'harness'),
    '--user-data', path.join(root, 'profile-B'),
    '--base-url', 'http://127.0.0.1:51515',
    '--token', TOKEN,
    '--models', modelsFile,
  ], root);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.ok(!res.stdout.includes(TOKEN), 'stdout must not print the loopback token');
  assert.ok(!res.stderr.includes(TOKEN), 'stderr must not print the loopback token');
});

test('shim refuses to run when P0.0 is not PASS', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'FAIL');
  const modelsFile = path.join(root, 'models.json');
  await modelsFixtureFile(root, THREE_MODELS);

  const res = await runShim([
    '--candidate', 'B',
    '--gate', gate,
    '--harness-root', path.join(root, 'harness'),
    '--user-data', path.join(root, 'profile-B'),
    '--base-url', 'http://127.0.0.1:51515',
    '--token', TOKEN,
    '--models', modelsFile,
  ], root);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /P0\.0/);
});

// ---------------------------------------------------------------------------
// 3. PowerShell 5.1 parse-ability of the runner + shim/parser wiring
// ---------------------------------------------------------------------------

const RUNNER = path.join(ROOT, 'scripts', 'Invoke-CorrectivePhase3.ps1');

test('Invoke-CorrectivePhase3.ps1 parses cleanly in Windows PowerShell 5.1', () => {
  const quoted = RUNNER.replaceAll("'", "''");
  const command =
    `$e=$null;$t=$null;` +
    `[Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$t,[ref]$e)|Out-Null;` +
    `if($e){$e|% Message;exit 1}`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stdout || res.stderr);
});

test('runner never passes ANTHROPIC_BASE_URL/AUTH_TOKEN to the client (real configLibrary path only)', async () => {
  const src = await readFile(RUNNER, 'utf8');
  // We are testing the real 3P config-library path; env-var activation is
  // explicitly out of scope for P0.3 and must not be set on the client process.
  assert.doesNotMatch(src, /EnvironmentVariables\['ANTHROPIC_BASE_URL'\]/);
  assert.doesNotMatch(src, /EnvironmentVariables\['ANTHROPIC_AUTH_TOKEN'\]/);
});

test('runner separates client-originated /v1/messages from the adapter-loopback proof', async () => {
  const src = await readFile(RUNNER, 'utf8');
  // P0.3 requires the CLIENT to emit POST /v1/messages. The loopback proof uses
  // the same token/config but must be labeled distinctly and can never be
  // conflated with the client-originated requirement.
  assert.match(src, /clientOriginated/);
  assert.match(src, /loopback/i);
  assert.match(src, /CLAUDE_OPEN_GATEWAY_OK/);
});

test('runner reads only the disposable profile main.log, never the normal Claude profile logs', async () => {
  const src = await readFile(RUNNER, 'utf8');
  assert.match(src, /main\.log/i);
  assert.doesNotMatch(
    src,
    /APPDATA['"\s)]*\)?\s*['"]Claude\\logs|LOCALAPPDATA['"\s)]*\)?\s*['"]Claude\\Logs|Claude-3p\\Logs/i,
  );
  // Processes must be force-killed with their tree in a finally.
  assert.match(src, /taskkill/i);
});
