// Model normalization: turn a raw gateway model record into the canonical
// Claude Open model shape. (Plan 7.2; NEXT-INSTRUCTIONS 5.2/5.3.)
//
// Corrections vs the earlier version:
//   - capabilities are THREE-STATE ('supported'|'unsupported'|'unknown') and are
//     NEVER defaulted to true. They come from gateway metadata, then the
//     data-driven registry, else 'unknown'.
//   - model TYPE is classified (text-chat / reasoning-text / vision-input /
//     image-generation / audio-voice / embedding / local-gguf / unknown).
//   - context/limits come only from the gateway catalog or an override, with
//     provenance; never a global default.
//   - effort/reasoning is expressed as a reasoning-control descriptor, never a
//     fabricated low/medium/high ladder.

import { AliasMap } from './alias.js';

/** @typedef {'supported'|'unsupported'|'unknown'} TriState */

function pickNumber(rec, keys) {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** Read a tri-state capability from gateway metadata; 'unknown' if absent. */
function metaTri(rec, keys) {
  for (const k of keys) {
    const v = rec[k];
    if (v === true) return 'supported';
    if (v === false) return 'unsupported';
  }
  const caps = rec.capabilities;
  if (caps && typeof caps === 'object') {
    for (const k of keys) {
      if (caps[k] === true) return 'supported';
      if (caps[k] === false) return 'unsupported';
    }
  }
  return 'unknown';
}

/** Merge two tri-state values: a definite gateway value wins over registry. */
function mergeTri(gateway, registry) {
  if (gateway === 'supported' || gateway === 'unsupported') return gateway;
  if (registry === 'supported' || registry === 'unsupported') return registry;
  return 'unknown';
}

/**
 * Resolve context window ONLY from gateway metadata or an override; record the
 * source. Never invent a global value.
 */
export function resolveContext(rec, override) {
  if (override && typeof override.contextWindow === 'number') {
    return { window: override.contextWindow, source: 'override' };
  }
  const w = pickNumber(rec, [
    'context_length',
    'context_window',
    'max_context_tokens',
    'input_token_limit',
    // A number of OpenAI-compatible gateways expose only max_input_tokens.
    // It is still gateway-provided context capacity, not an invented default.
    'max_input_tokens',
    'max_prompt_tokens',
    'context',
  ]);
  if (w != null) return { window: w, source: 'gateway' };
  const nested = [
    rec.context?.window,
    rec.context?.length,
    rec.limits?.context_window,
    rec.limits?.context_length,
    rec.token_limits?.context_window,
  ].find((value) => typeof value === 'number' && Number.isFinite(value));
  if (nested != null) return { window: nested, source: 'gateway' };
  return { window: null, source: 'unknown' };
}

/**
 * Normalize one raw gateway model record using the capability registry.
 * @param {object} rec raw gateway model record
 * @param {AliasMap} aliasMap
 * @param {object} opts
 * @param {(id:string)=>object} opts.resolveCaps  registry lookup -> capability record
 * @param {object} [opts.override]  config.modelOverrides[realId]
 * @returns {object} normalized model
 */
export function normalizeModel(rec, aliasMap, { resolveCaps, override } = {}) {
  const realId = String(rec.id);
  const caps = resolveCaps ? resolveCaps(realId) : null;
  const ctx = resolveContext(rec, override);

  // capabilities: gateway metadata first, then registry, else unknown.
  const gwTools = metaTri(rec, ['tools', 'supports_tools', 'function_calling']);
  const gwStream = metaTri(rec, ['streaming', 'supports_streaming', 'stream']);
  const gwImage = metaTri(rec, ['image_input', 'supports_images', 'vision']);

  const tools = mergeTri(override?.tools ?? gwTools, caps?.tools ?? 'unknown');
  const streaming = mergeTri(gwStream, caps?.streaming ?? 'unknown');
  const imageInput = mergeTri(
    gwImage,
    caps && Array.isArray(caps.modalities?.input) && caps.modalities.input.includes('image')
      ? 'supported'
      : 'unknown',
  );

  const modelType = override?.modelType ?? caps?.modelType ?? 'unknown';

  return {
    realId,
    stableAlias: aliasMap.aliasFor(realId),
    displayName: override?.displayName ?? rec.display_name ?? rec.name ?? realId,
    provider: override?.provider ?? caps?.provider ?? rec.owned_by ?? null,
    family: override?.family ?? caps?.family ?? null,
    modelType,
    routes: override?.route ? [override.route] : (caps?.routes ?? []),
    contextWindow: ctx.window,
    context: ctx,
    maxInputTokens: pickNumber(rec, ['max_input_tokens', 'max_prompt_tokens']),
    maxOutputTokens: pickNumber(rec, ['max_output_tokens', 'max_tokens', 'max_completion_tokens']),
    capabilities: {
      text:
        modelType === 'image-generation' || modelType === 'audio-voice' || modelType === 'embedding'
          ? 'unsupported'
          : modelType === 'unknown'
            ? 'unknown'
            : 'supported',
      imageInput,
      tools,
      streaming,
    },
    reasoning: override?.reasoning ?? caps?.reasoning ?? { controlType: 'unknown' },
    unavailableReason: caps?.unavailableReason ?? null,
    capabilitySource: caps?.matchedRecord ? 'registry' : 'unknown',
    provenance: caps?.source ?? null,
    confidence: caps?.confidence ?? 'none',
    sourceMetadata: rec,
  };
}

/**
 * Normalize a full model list.
 * @param {Array<object>} rawList
 * @param {AliasMap} aliasMap
 * @param {object} opts { resolveCaps, modelOverrides }
 * @returns {object[]}
 */
export function normalizeCatalog(rawList, aliasMap, { resolveCaps, modelOverrides = {} } = {}) {
  const list = (rawList || []).filter((m) => m && m.id != null);
  return list.map((rec) =>
    normalizeModel(rec, aliasMap, { resolveCaps, override: modelOverrides[String(rec.id)] }),
  );
}
