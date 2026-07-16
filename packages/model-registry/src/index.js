// @claude-open/model-registry
//
// Data-driven capability + reasoning-control lookup (NEXT-INSTRUCTIONS 5-6).
// Model facts live in data/registry.json, NOT in source conditionals. This
// module only:
//   - loads + validates the data records,
//   - matches a model id to the most specific record via EXPLICIT rules,
//   - returns a resolved capability record with three-state capabilities and
//     full provenance.
//
// Everything the data does not assert stays "unknown". Nothing is fabricated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'registry.json');

/** @typedef {'supported'|'unsupported'|'unknown'} TriState */

export const REASONING_CONTROL_TYPES = [
  'none',
  'categorical',
  'boolean',
  'numeric_budget',
  'model_variant',
  'automatic_only',
  'unknown',
];

export const MODEL_TYPES = [
  'text-chat',
  'reasoning-text',
  'vision-input',
  'image-generation',
  'audio-voice',
  'embedding',
  'local-gguf',
  'unknown',
];

/** Load and lightly validate the registry data. */
export function loadRegistry(path = DATA_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.records)) throw new Error('registry.json: records must be an array');
  for (const r of raw.records) {
    if (!r.id || !r.match || !r.match.kind || !r.match.pattern) {
      throw new Error(`registry.json: record missing id/match: ${JSON.stringify(r.id)}`);
    }
    if (r.reasoning && !REASONING_CONTROL_TYPES.includes(r.reasoning.controlType)) {
      throw new Error(`registry.json: bad reasoning.controlType in ${r.id}`);
    }
    if (r.modelType && !MODEL_TYPES.includes(r.modelType)) {
      throw new Error(`registry.json: bad modelType in ${r.id}`);
    }
  }
  return raw;
}

/**
 * Does an explicit match rule match a model id?
 * @param {{kind:'exact'|'prefix'|'regex', pattern:string}} rule
 * @param {string} id
 */
export function matchRule(rule, id) {
  const s = String(id);
  if (rule.kind === 'exact') return s === rule.pattern;
  if (rule.kind === 'prefix') return s.toLowerCase().startsWith(rule.pattern.toLowerCase());
  if (rule.kind === 'regex') return new RegExp(rule.pattern, 'i').test(s);
  return false;
}

/**
 * Score a rule's specificity so the MOST specific record wins when several
 * match. exact > longer-pattern regex/prefix > shorter. This keeps e.g. the
 * gemini "-low variant" record ahead of the generic "gemini-3" record.
 */
function specificity(rule) {
  const base = rule.kind === 'exact' ? 1000 : rule.kind === 'regex' ? 100 : 10;
  return base + rule.pattern.length;
}

/**
 * Resolve the capability record for a model id from the registry.
 * Returns an "unknown" skeleton when no record matches — never a guess.
 * @param {object} registry loaded registry object
 * @param {string} id
 * @returns {object} resolved capability record
 */
export function resolveCapabilities(registry, id) {
  const matches = registry.records
    .filter((r) => matchRule(r.match, id))
    .sort((a, b) => specificity(b.match) - specificity(a.match));

  if (matches.length === 0) {
    return {
      matchedRecord: null,
      provider: null,
      family: null,
      modelType: 'unknown',
      routes: [],
      modalities: { input: [], output: [] },
      tools: 'unknown',
      streaming: 'unknown',
      reasoning: { controlType: 'unknown' },
      unavailableReason: null,
      source: null,
      confidence: 'none',
    };
  }

  const r = matches[0];
  return {
    matchedRecord: r.id,
    provider: r.provider ?? null,
    family: r.family ?? null,
    modelType: r.modelType ?? 'unknown',
    routes: Array.isArray(r.routes) ? r.routes.slice() : [],
    modalities: r.modalities ?? { input: [], output: [] },
    tools: r.tools ?? 'unknown',
    streaming: r.streaming ?? 'unknown',
    reasoning: r.reasoning ?? { controlType: 'unknown' },
    unavailableReason: r.unavailableReason ?? null,
    source: r.source ?? null,
    confidence: r.confidence ?? 'unknown',
  };
}

/** Is a resolved model usable in Claude Desktop's chat picker? */
export function isChatUsable(caps) {
  if (caps.modelType === 'image-generation' || caps.modelType === 'audio-voice' || caps.modelType === 'embedding') {
    return false;
  }
  if (Array.isArray(caps.routes) && caps.routes.length === 1 && caps.routes[0] === 'unsupported') {
    return false;
  }
  return true;
}
