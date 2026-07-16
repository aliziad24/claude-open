# Usage and context

Claude Open records tokens returned by the gateway for requests passing through the current adapter process. It normalizes standard Anthropic and OpenAI-compatible usage shapes, including cache and reasoning fields when supplied.

The Control Center and in-client widget can show request count, input/output/cache/reasoning tokens, per-model totals, available model count, and known context size. Widget snapshots are written atomically to the copied renderer directory and contain no gateway URL, key, or local runtime token.

Session usage is not account billing, subscription quota, or a complete provider total. It resets with the adapter and excludes other clients. Missing provider usage or context data remains unknown; estimates are labeled rather than presented as exact.
