import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const launcher = readFileSync(new URL('../../apps/launcher/ClaudeOpen.cs', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../../assets/z-usage-widget.js', import.meta.url), 'utf8');

test('SSH Code uses a managed remote-loopback reverse forward to the live adapter port', () => {
  assert.match(launcher, /-R " \+ forward/);
  assert.match(launcher, /127\.0\.0\.1:" \+ activePort \+ ":127\.0\.0\.1:/);
  assert.match(launcher, /BatchMode=yes/);
  assert.match(launcher, /ExitOnForwardFailure=yes/);
  assert.match(launcher, /Path\.Combine\(profilePath, "ssh_configs\.json"\)/);
  assert.match(launcher, /StopSshBridges\(\)/);
  assert.doesNotMatch(launcher, /0\.0\.0\.0.*-R|-R.*0\.0\.0\.0/);
});

test('usage Refresh waits for a newly generated adapter snapshot', () => {
  assert.match(widget, /waitForNewerThan/);
  assert.match(widget, /gateway\?\.fetchedAt/);
  assert.match(widget, /live gateway snapshot did not advance/);
  assert.match(widget, /Stale gateway snapshot/);
  assert.match(widget, /Refreshing…/);
  assert.match(widget, /setInterval\(refresh, POLL_MS\)/);
  assert.match(widget, /const POLL_MS = 5000/);
});

test('usage context matches alias ids, display names, real ids, and standard gateway limit fields', () => {
  assert.match(widget, /model\?\.display_name/);
  assert.match(widget, /model\?\.claude_open\?\.realId/);
  assert.match(widget, /model\?\.claude_open\?\.contextWindow/);
  assert.match(widget, /ctx unavailable/);
  assert.doesNotMatch(widget, /['"`]\? ctx['"`]/);
});
