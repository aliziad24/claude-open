#!/usr/bin/env node
// scripts/write-3p-config.mjs
//
// Thin CLI shim over @claude-open/identity-harness createCandidateWorkspace.
// It exists so the PowerShell 5.1 runner (Invoke-CorrectivePhase3.ps1) can write
// the EXACT FLAT config-library contract for Claude Desktop 1.20186.1 without
// duplicating the harness logic in PowerShell. All contract truth stays in the
// harness; this shim only marshals CLI args -> harness options and prints a
// redacted result.
//
// It NEVER prints the ephemeral loopback token. deploymentMode:"3p" is written
// only into claude_desktop_config.json (via the harness `preferences` merge),
// never into the config-library file.
//
// Usage (experiment path — requires a P0.0 PASS gate):
//   node scripts/write-3p-config.mjs \
//     --candidate B --gate <run.json> --harness-root <dir> --user-data <dir> \
//     --base-url http://127.0.0.1:<port> --token <ephemeral-loopback-token> \
//     --models <models.json> [--default <alias>] [--model-discovery]
//     [--config-name <name>]
//
// Usage (production launch path — NO gate; used by the Control Center):
//   node scripts/write-3p-config.mjs --production \
//     --harness-root <dir> --user-data <dir> \
//     --base-url http://127.0.0.1:<port> --token <ephemeral-loopback-token> \
//     --models <models.json> [--default <alias>] [--model-discovery]
//     [--config-name <name>]
//
// The P0.0 gate guards candidate experiments only; the production launch path
// (createProductionWorkspace) never requires it. --gate is ignored under
// --production.
//
// --models points to a JSON file: an array of { id, display_name } read live
// from the adapter /v1/models (id = stableAlias, display_name = display name).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assignFamilyTiers,
  createCandidateWorkspace,
  createProductionWorkspace,
} from '../packages/identity-harness/src/index.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const production = args.production === true || args.production === 'true';

  // --gate is required only for the experiment path; production never uses it.
  const required = production
    ? ['harness-root', 'user-data', 'base-url', 'models']
    : ['gate', 'harness-root', 'user-data', 'base-url', 'models'];
  for (const key of required) {
    if (!args[key]) fail(`missing required --${key}`);
  }
  const token = args.token || process.env.GATEWAY_API_KEY || '';
  if (!token) fail('missing gateway token (use GATEWAY_API_KEY)');

  const candidateId = args.candidate || 'B';
  const modelsRaw = await readFile(path.resolve(args.models), 'utf8');
  let models = JSON.parse(modelsRaw);
  if (!Array.isArray(models) || models.length === 0) {
    fail('--models file must contain a non-empty JSON array of { id, display_name }');
  }

  // Normalize model records and enforce the exact { id, display_name } shape the
  // harness expects. Any extra fields (supports1m, anthropicFamilyTier, ...) are
  // passed through when present.
  models = models.map((m) => {
    if (!m || typeof m.id !== 'string') fail('each model needs a string id');
    const record = { id: m.id, display_name: m.display_name ?? m.id };
    if (typeof m.supports1m === 'boolean') record.supports1m = m.supports1m;
    if (m.anthropicFamilyTier) record.anthropicFamilyTier = m.anthropicFamilyTier;
    if (typeof m.isFamilyDefault === 'boolean') record.isFamilyDefault = m.isFamilyDefault;
    // familyTiers[] carries the multi-tier family-default marker produced by the
    // harness assignFamilyTiers helper. The FLAT serializer expands it into one
    // inferenceModels item per tier so the client's per-tier ConfigHealth probe
    // (haiku|sonnet|opus) resolves to a HEALTHY model
    // (tests/fixtures/claude-3p-config/README.md:99-101).
    if (Array.isArray(m.familyTiers) && m.familyTiers.length) {
      record.familyTiers = m.familyTiers.filter((t) => typeof t === 'string');
    }
    return record;
  });

  // Optional family-tier assignment: tag HEALTHY models with anthropicFamilyTier
  // + isFamilyDefault so the client's ConfigHealth / first-inference probe (which
  // resolves by tier, NOT by inferenceModels ordering) lands on a HEALTHY model
  // instead of the built-in overloaded claude-haiku-4-5 tier id. --unhealthy is a
  // comma-separated list of currently-overloaded aliases to avoid. Documented
  // lever: tests/fixtures/claude-3p-config/README.md:99-101.
  if (args['assign-family-tiers'] === true || args['assign-family-tiers'] === 'true') {
    const unhealthyIds = typeof args.unhealthy === 'string'
      ? args.unhealthy.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    models = assignFamilyTiers(models, { unhealthyIds });
  }

  // Optional default: hoist the chosen alias to the front (harness treats the
  // first inferenceModels entry as Claude Desktop's default).
  if (args.default) {
    const idx = models.findIndex((m) => m.id === args.default);
    if (idx < 0) fail(`--default '${args.default}' is not present in the models list`);
    const [chosen] = models.splice(idx, 1);
    models.unshift(chosen);
  }

  const workspaceOpts = {
    candidateId,
    harnessRoot: path.resolve(args['harness-root']),
    userDataRoot: path.resolve(args['user-data']),
    loopbackBaseUrl: args['base-url'],
    ephemeralToken: token,
    models,
    // deploymentMode 3p lives ONLY in claude_desktop_config.json (preferences).
    preferences: { deploymentMode: '3p' },
    configName: args['config-name'] || 'Claude Open Gateway',
    modelDiscoveryEnabled: args['model-discovery'] === true || args['model-discovery'] === 'true',
  };

  let result;
  try {
    if (production) {
      // Production launch path: no P0.0 gate, genuine WindowsApps host.
      result = await createProductionWorkspace(workspaceOpts);
    } else {
      result = await createCandidateWorkspace({
        ...workspaceOpts,
        evidenceFile: path.resolve(args.gate),
      });
    }
  } catch (err) {
    fail(err.message);
    return;
  }

  // Emit a redacted result: paths, ids, and the default alias only — NEVER the
  // token. The harness itself never returns the token; assert defensively.
  const payload = {
    status: result.status,
    experimentRan: result.experimentRan,
    configurationId: result.configurationId,
    // Production forces candidate 'C' (genuine WindowsApps host); reflect that.
    candidateId: production ? 'C' : candidateId,
    mode: production ? 'production' : 'experiment',
    defaultAlias: models[0].id,
    modelCount: models.length,
    paths: result.paths,
  };
  const serialized = JSON.stringify(payload, null, 2);
  if (serialized.includes(token)) {
    fail('refusing to print result: loopback token would leak');
  }
  process.stdout.write(serialized + '\n');
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`);
  process.exit(1);
});
