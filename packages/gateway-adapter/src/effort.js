// Per-model reasoning / effort control. (SESSION-3 section 5.2; plan 7.6.)
//
// `mapThinkingToUpstream()` returns a STRUCTURED PATCH describing exactly where
// and what to set on the upstream request for THIS model's reasoning-control
// type — it does NOT itself mutate a request. The caller applies the patch at
// the correct nested field for the correct protocol. This lets one function
// serve every route without generic low/medium/high coercion.
//
// Patch shape:
//   { apply: 'set-path', path: 'reasoning.effort', value: 'high' }
//   { apply: 'set-path', path: 'thinking.type',    value: 'enabled' }
//   { apply: 'set-path', path: 'thinkingConfig.thinkingBudget', value: 8000 }
//   { apply: 'none' }                    // model_variant / automatic_only / none / unknown / disabled
//
// Anthropic numeric budgets are NEVER coerced into low/medium/high with global
// thresholds. For the anthropic route we preserve the native thinking block.

/**
 * Build the reasoning-control descriptor Claude Open should advertise for a model.
 * @param {object} model normalized model (has `reasoning`, `capabilitySource`)
 * @param {object} [override] modelOverrides[realId].reasoning
 * @param {object} [probeResult] saved live-probe reasoning result
 * @returns {{controlType:string, field?:string, values?:any, default?:any, min?:number, max?:number, specialValues?:object, source:string, showSelector:boolean}}
 */
export function reasoningControl(model, override, probeResult) {
  let rc = model?.reasoning ?? { controlType: 'unknown' };
  let source = model?.capabilitySource === 'registry' ? 'registry' : 'gateway-or-unknown';
  if (probeResult && probeResult.controlType) {
    rc = probeResult;
    source = 'probe';
  }
  if (override && override.controlType) {
    rc = override;
    source = 'override';
  }
  const ct = rc.controlType;
  const showSelector = ct === 'categorical' || ct === 'boolean' || ct === 'numeric_budget';
  return { ...rc, source, showSelector };
}

/**
 * Given the app's inbound Anthropic `thinking` block and the model's resolved
 * control descriptor + target route, return a structured patch for the upstream
 * request. Never invents a value the control type does not define.
 *
 * @param {object|null} thinking Anthropic thinking block ({type, budget_tokens})
 * @param {object} control result of reasoningControl()
 * @param {string} route 'anthropic' | 'openai-chat' | 'openai-responses'
 * @returns {{apply:'set-path', path:string, value:any}|{apply:'none', reason:string}}
 */
export function mapThinkingToUpstream(input, control, route) {
  const ct = control.controlType;
  const none = (reason) => ({ apply: 'none', reason });
  // The latest Anthropic request carries categorical effort at
  // `output_config.effort`. Thinking remains an independent block. Accepting a
  // whole request here prevents an invented `thinking.effort` convention.
  const request = input && (input.thinking !== undefined || input.output_config !== undefined || input.messages)
    ? input
    : { thinking: input };
  const thinking = request.thinking ?? null;
  const selectedEffort = request.output_config?.effort;

  if (ct === 'none') return none('model has no user-controlled reasoning');
  if (ct === 'unknown') return none('reasoning control unknown; not sending a control');
  if (ct === 'model_variant') return none('effort is encoded in the model id; no separate control');
  if (ct === 'automatic_only') return none('model reasons automatically; no user control');

  const hasThinking = thinking != null;
  const enabled = hasThinking && thinking.type !== 'disabled';

  // BOOLEAN (e.g. GLM thinking.type = enabled/disabled). OpenAI-compatible chat
  // providers accept this as a top-level or nested field named by the registry.
  if (ct === 'boolean') {
    if (!hasThinking) return none('thinking omitted; preserve provider default');
    const field = control.field || 'thinking.type';
    const vals = Array.isArray(control.values) && control.values.length === 2 ? control.values : ['enabled', 'disabled'];
    const value = enabled ? vals[0] : vals[1];
    if (Array.isArray(control.allowedValues) && !control.allowedValues.includes(value)) {
      return none(`boolean value '${value}' is not proven for this gateway`);
    }
    return { apply: 'set-path', path: field, value };
  }

  // NUMERIC BUDGET (e.g. Gemini thinkingBudget with off/dynamic special values).
  if (ct === 'numeric_budget') {
    if (!hasThinking) return none('thinking omitted; preserve provider default');
    const field = control.field || 'thinkingConfig.thinkingBudget';
    if (!enabled) {
      if (control.specialValues && 'off' in control.specialValues) {
        return { apply: 'set-path', path: field, value: control.specialValues.off };
      }
      return none('thinking disabled and no documented off value');
    }
    if (typeof thinking.budget_tokens === 'number') {
      let v = thinking.budget_tokens;
      if (typeof control.min === 'number') v = Math.max(control.min, v);
      if (typeof control.max === 'number') v = Math.min(control.max, v);
      if (Array.isArray(control.allowedValues) && !control.allowedValues.includes(v)) {
        return none(`numeric budget '${v}' is not proven for this gateway`);
      }
      return { apply: 'set-path', path: field, value: v };
    }
    if (control.specialValues && 'dynamic' in control.specialValues) {
      const value = control.specialValues.dynamic;
      if (Array.isArray(control.allowedValues) && !control.allowedValues.includes(value)) {
        return none(`dynamic value '${value}' is not proven for this gateway`);
      }
      return { apply: 'set-path', path: field, value };
    }
    return none('adaptive thinking with no numeric budget and no dynamic value');
  }

  // CATEGORICAL (named levels). Field differs by route/provider (reasoning.effort,
  // thinking_level, reasoning_effort). We emit ONLY an explicitly-selected value
  // or the documented default. We DO NOT infer a level from token budgets — that
  // was a generic guess and is removed (SESSION-4 phase 3.2 / no-global-guess).
  if (ct === 'categorical') {
    const levels = Array.isArray(control.values) ? control.values : [];
    if (!levels.length) return none('no advertised categorical values');
    const field = control.field || defaultCategoricalField(route);

    // Explicit categorical selection from the real Anthropic wire field.
    if (typeof selectedEffort === 'string' && levels.includes(selectedEffort) &&
        (!Array.isArray(control.allowedValues) || control.allowedValues.includes(selectedEffort))) {
      return { apply: 'set-path', path: field, value: selectedEffort };
    }
    return none('no explicit output_config.effort selection');
  }

  return none('unhandled control type');
}

function defaultCategoricalField(route) {
  if (route === 'openai-responses') return 'reasoning.effort';
  // openai-chat compatible providers vary; the registry SHOULD name the field.
  return 'reasoning_effort';
}

/**
 * Apply a structured patch to a request object at a dotted path.
 * Anthropic route note: the caller should PRESERVE the native `thinking` block
 * and NOT apply categorical/budget coercion (pass route='anthropic' -> the
 * anthropic-native builder keeps thinking as-is).
 * @param {object} req
 * @param {{apply:string, path?:string, value?:any}} patch
 * @returns {object} the same req (mutated) for convenience
 */
export function applyPatch(req, patch) {
  if (!patch || patch.apply !== 'set-path') return req;
  const parts = patch.path.split('.');
  let cur = req;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = patch.value;
  return req;
}
