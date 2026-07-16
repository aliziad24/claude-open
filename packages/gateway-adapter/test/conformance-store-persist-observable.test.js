// Security-review defect 2(c): ConformanceStore._persist() silently discarded
// write failures in an empty catch, so a failed write of verified probe results
// was completely invisible. The store now accepts an injected logger and emits a
// structured warning (never throws) when a persist write fails, so a silent
// write failure is observable.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { ConformanceStore } from '../src/conformance-store.js';

// Return a persistence path whose parent directory CANNOT be created because a
// real FILE sits where a directory component is expected (mkdirSync -> ENOTDIR).
// This deterministically forces _persist() to fail on any platform.
function unwritablePath(tag) {
  const file = path.join(os.tmpdir(), `co-conf-${tag}-${process.pid}-${Date.now()}`);
  writeFileSync(file, 'x'); // occupy the name with a file
  return path.join(file, 'nested', 'conformance.json');
}

function probeRecord() {
  return {
    fingerprint: 'gw.example',
    realId: 'gpt-5.5',
    route: 'openai-chat',
    field: 'reasoning.effort',
    value: 'high',
    result: 'behavior-observed',
    evidence: 'observed a behavior delta',
  };
}

test('record() logs a warning (not a throw) when the persist write fails', () => {
  const events = [];
  // Point the store at a path whose parent cannot be created: a file used as a
  // directory component makes mkdirSync/writeFileSync fail deterministically.
  const badPath = unwritablePath('warn');
  const store = new ConformanceStore({
    filePath: badPath,
    version: 'v-test',
    log: (line) => events.push(line),
  });

  // A parse/load failure must not have prevented construction.
  assert.doesNotThrow(() => store.record(probeRecord()));

  const warn = events.find((e) => e && e.evt === 'warn');
  assert.ok(warn, 'a persist failure must emit a warn event');
  assert.match(warn.msg, /conformance persist failed/i);
  // The failing file path must be observable to make the failure diagnosable.
  assert.ok(warn.msg.includes(badPath) || (warn.path && warn.path.includes('conformance.json')),
    'the warning must reference the file that could not be written');
});

test('a missing logger still does not throw on a persist failure (default no-op)', () => {
  const badPath = unwritablePath('noop');
  const store = new ConformanceStore({ filePath: badPath, version: 'v-test' });
  assert.doesNotThrow(() => store.record(probeRecord()));
});

test('the persist logger does not leak a secret-shaped string', () => {
  const events = [];
  const badPath = unwritablePath('red');
  const store = new ConformanceStore({ filePath: badPath, version: 'v-test', log: (l) => events.push(l) });
  store.record(probeRecord());
  const joined = JSON.stringify(events);
  assert.doesNotMatch(joined, /sk-[A-Za-z0-9\-_]{8,}/);
});
