# Models and reasoning effort

Models come from the configured gateway's live discovery response. Stable aliases prevent unsafe IDs from becoming local paths or configuration keys, while the real model ID and display name remain available in metadata.

Capabilities are `supported`, `unsupported`, or `unknown`. Unknown is never promoted to supported merely to make a control appear.

Reasoning controls can be categorical, boolean, numeric-budget, model-variant, automatic-only, none, or unknown. The exact field and typed value are model/route specific. Claude Open does not apply a universal effort list or default.

The selector is advertised to the official client only for behaviorally verified categorical controls. The Control Center distinguishes documented candidates, schema acceptance, behavioral observation, silent ignore, rejection, and unknown. Probe requests are real gateway requests and may be billable.
