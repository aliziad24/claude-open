import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runner = path.join(root, 'scripts', 'Invoke-CorrectivePhase0.ps1');
const liveProbe = path.join(root, 'scripts', 'Invoke-CorrectivePhase0LiveProbe.ps1');
const observationIds = [
  'healthy-adapter-38-chat-models',
  'client-1p-onboarding',
  'zero-adapter-message-traffic',
  'light-control-center',
  'stale-runtime-record',
  'copied-client-cowork-baseline',
];

async function writeObservation(rootPath, id, actual, extra = {}) {
  await writeFile(
    path.join(rootPath, `${id}.json`),
    JSON.stringify({ id, observed: true, actual, ...extra }),
  );
}

async function invokeFixture({ complete = true, sensitive = false } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'co-phase0-test-'));
  const observations = path.join(temp, 'observations');
  const evidence = path.join(temp, 'evidence');
  await mkdir(observations);

  // The sensitive marker is assembled at runtime from fragments so this source
  // file contains NO literal secret-shaped token. This keeps the whole-tree
  // release-privacy scan (verify-release.ps1) green without a broad test-dir
  // exclusion that could mask a real leaked credential (NEXT-WAVE C8), while
  // still exercising the private-evidence redactor end to end.
  const syntheticToken = ['TESTSECRET', '0123456789'].join('');
  const sensitiveMarker =
    ['authorization:', 'Bearer', syntheticToken].join(' ') +
    ' ' +
    ['conversation:', 'PRIVATE-CONTENT-DO-NOT-KEEP'].join(' ');
  const ids = complete ? observationIds : observationIds.slice(0, 5);
  for (const id of ids) {
    const suffix = sensitive && id === observationIds[0] ? ` ${sensitiveMarker}` : '';
    await writeObservation(observations, id, `synthetic observation for ${id}${suffix}`);
  }

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', runner,
    '-EvidenceRoot', evidence,
    '-ObservationRoot', observations,
    '-FixtureMode',
  ], { cwd: root, encoding: 'utf8' });

  const children = await readdir(evidence).catch(() => []);
  assert.equal(children.length, 1, `expected one evidence run; stdout=${result.stdout}; stderr=${result.stderr}`);
  const runPath = path.join(evidence, children[0]);
  return { temp, result, runPath, run: JSON.parse(await readFile(path.join(runPath, 'run.json'), 'utf8')) };
}

test('complete sanitized evidence captures all six failures and passes P0.0', async (t) => {
  const fixture = await invokeFixture({ sensitive: true });
  t.after(() => rm(fixture.temp, { recursive: true, force: true }));

  assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout);
  assert.match(fixture.run.runId, /^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{8}$/);
  assert.ok(Date.parse(fixture.run.startedAtUtc));
  assert.ok(Date.parse(fixture.run.finishedAtUtc));
  assert.equal(fixture.run.source.commit.length, 40);
  assert.equal(typeof fixture.run.source.status, 'string');
  assert.match(fixture.run.source.sourceHash, /^[A-Fa-f0-9]{64}$/);
  assert.equal(fixture.run.source.sourceHashAlgorithm, 'SHA-256 file manifest');
  assert.equal(typeof fixture.run.build.discoveryStatus, 'string');
  assert.equal(typeof fixture.run.system.osBuild, 'string');
  assert.equal(typeof fixture.run.system.dpi, 'number');
  assert.equal(typeof fixture.run.installedClaude.discoveryStatus, 'string');
  assert.deepEqual(fixture.run.observations.map((item) => item.id), observationIds);
  assert.ok(fixture.run.observations.every((item) => item.status === 'OBSERVED'));
  assert.equal(fixture.run.p0_0.status, 'PASS');

  const serialized = JSON.stringify(fixture.run);
  // Reconstructed at runtime so this source line carries no secret-shaped literal.
  const leakedToken = ['TESTSECRET', '0123456789'].join('');
  const leakedPrivate = ['PRIVATE-CONTENT', 'DO-NOT-KEEP'].join('-');
  assert.ok(!serialized.includes(leakedToken), 'ephemeral token must be redacted from evidence');
  assert.ok(!serialized.includes(leakedPrivate), 'private content marker must be redacted from evidence');
  assert.match(serialized, /\[REDACTED\]/);

  const manifest = JSON.parse(await readFile(path.join(fixture.runPath, 'hash-manifest.json'), 'utf8'));
  assert.ok(manifest.files.some((item) => item.path === 'run.json' && /^[A-Fa-f0-9]{64}$/.test(item.sha256)));
  const scan = JSON.parse(await readFile(path.join(fixture.runPath, 'redaction-scan.json'), 'utf8'));
  assert.equal(scan.status, 'PASS');
  assert.equal(scan.remainingFindings.length, 0);
});

test('missing live observation is NOT RUN with an exact reason and cannot pass P0.0', async (t) => {
  const fixture = await invokeFixture({ complete: false });
  t.after(() => rm(fixture.temp, { recursive: true, force: true }));

  assert.equal(fixture.result.status, 2, fixture.result.stderr || fixture.result.stdout);
  const missing = fixture.run.observations.find((item) => item.id === 'copied-client-cowork-baseline');
  assert.equal(missing.status, 'NOT RUN');
  assert.match(missing.reason, /No safe observation source was found/);
  assert.equal(fixture.run.p0_0.status, 'FAIL');
  assert.match(fixture.run.p0_0.reason, /copied-client-cowork-baseline: NOT RUN/);
});

test('private corrective evidence root is ignored by git', () => {
  const result = spawnSync('git', ['check-ignore', '-q', 'test-results/corrective/example/run.json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, 'test-results/corrective/** must be excluded by .gitignore');
});

test('runner default parameters parse in Windows PowerShell 5.1', () => {
  const quoted = runner.replaceAll("'", "''");
  const command = `$e=$null;$t=$null;[Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$t,[ref]$e)|Out-Null;if($e){$e|% Message;exit 1}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout || result.stderr);
});

test('live probe is opt-in and constrained to disposable evidence paths', async () => {
  const runnerSource = await readFile(runner, 'utf8');
  const probeSource = await readFile(liveProbe, 'utf8');

  assert.match(runnerSource, /\[switch\]\$LiveSafeProbe/);
  assert.match(runnerSource, /Invoke-CorrectivePhase0LiveProbe\.ps1/);
  assert.match(probeSource, /CLAUDE_USER_DATA_DIR/);
  assert.match(probeSource, /taskkill\.exe/);
  assert.match(probeSource, /request-counters\.json/);
  assert.doesNotMatch(probeSource, /HKCU:|HKLM:|Set-ItemProperty|New-ItemProperty/);
});

test('live probe survives a transient gateway/health failure without aborting the run', async () => {
  const probeSource = await readFile(liveProbe, 'utf8');

  // A slow/unreachable gateway must degrade only the adapter-health observation
  // to NOT RUN; it must NOT throw and abandon the client-side observations or
  // the run summary. The health/models query must be in its own try/catch.
  assert.match(
    probeSource,
    /try\s*{[^}]*Invoke-RestMethod[^}]*health\/deep/s,
    'the deep-health query must be wrapped so a timeout does not abort the probe',
  );
  // Fail fast: a transient health timeout should not hang the whole run for two
  // minutes. Cap the health timeout well under the outer budget.
  assert.match(probeSource, /-TimeoutSec\s+([1-5]?\d)\b/, 'health query must use a short, fail-fast timeout');
});

test('live probe reads the isolated client main.log and never the normal Claude profile logs', async () => {
  const probeSource = await readFile(liveProbe, 'utf8');

  // Root cause of the two NOT RUN rows: deploymentMode + msix_required Cowork
  // flags are written to the Electron main.log under the redirected user-data
  // dir, not the chromium verbose log the probe originally scanned.
  assert.match(probeSource, /main\.log/i, 'probe must read the client Electron main.log');
  assert.match(probeSource, /\$profilePath/, 'probe must scope the log read to the disposable profile');

  // Plan rule 9: never read the live normal Claude profile logs (would ingest
  // private conversation content and touch normal Claude state).
  assert.doesNotMatch(
    probeSource,
    /APPDATA['"\s)]*\)?\s*['"]Claude\\logs|LOCALAPPDATA['"\s)]*\)?\s*['"]Claude\\Logs|Claude-3p\\Logs/i,
    'probe must not read normal Claude / Claude-3p profile logs',
  );
});
