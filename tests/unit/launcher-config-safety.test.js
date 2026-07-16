import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(root, 'apps', 'launcher', 'ClaudeOpen.cs'), 'utf8');

test('Control Center rejects credential-bearing URLs and remote plaintext HTTP', () => {
  assert.match(source, /new Uri\(url, UriKind\.Absolute\)/);
  assert.match(source, /!string\.IsNullOrEmpty\(uri\.UserInfo\)/);
  assert.match(source, /uri\.Scheme == "http" && !uri\.IsLoopback/);
});

test('custom authentication header must be syntactically valid and non-reserved', () => {
  assert.match(source, /Regex\.IsMatch\(headerName, "\^\[A-Za-z0-9/);
  for (const name of ['authorization', 'x-api-key', 'cookie', 'content-length']) {
    assert.ok(source.includes(`"${name}"`), `${name} remains reserved`);
  }
});

test('saving basic fields preserves advanced gateway configuration', () => {
  assert.match(source, /new Dictionary<string, object>\(currentConfig\)/);
  for (const key of ['profile', 'modelsEndpoint', 'usage', 'routes', 'modelOverrides']) {
    assert.match(source, new RegExp(`!config\\.ContainsKey\\("${key}"\\)`));
  }
});

test('Remote Companion remains explicit opt-in at adapter launch', () => {
  assert.match(source, /companionCheckBox\.Checked/);
  assert.match(source, /EnvironmentVariables\["CLAUDE_OPEN_COMPANION"\] = "1"/);
  assert.doesNotMatch(source, /EnvironmentVariables\["CLAUDE_OPEN_COMPANION"\] = "1";\s*else/);
  assert.match(source, /File\.Delete\(runtimeFile\)/, 'stopping removes retired local tokens and pairing code');
});
