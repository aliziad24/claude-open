# Usage and context

Claude Open records tokens returned by the gateway for requests passing through the current adapter process. It normalizes standard Anthropic and OpenAI-compatible usage shapes, including cache and reasoning fields when supplied.

The Control Center and in-client widget can show request count, input/output/cache/reasoning tokens, per-model totals, available model count, and known context size. Widget snapshots are written atomically to the copied renderer directory and contain no gateway URL, key, or local runtime token.

Session usage is not account billing, subscription quota, or a complete provider total. It resets with the adapter and excludes other clients. Missing provider usage or context data remains unknown; estimates are labeled rather than presented as exact.

## Optional gateway account usage

If your gateway publishes account plan or usage JSON, close Claude Open and add a vendor-neutral mapped adapter to `%APPDATA%\ClaudeOpen\config.json` (the same non-secret configuration maintained by Control Center):

```json
{
  "usage": {
    "adapter": "mapped",
    "planEndpoint": "/your/plan/endpoint",
    "usageEndpoint": "/your/usage/endpoint"
  }
}
```

Endpoints must be relative to the configured gateway origin. Claude Open calls them through the same base URL and the same active Credential Manager secret used for models and inference. The API key is never copied into the widget snapshot. Data refreshes every 10 seconds, and the widget's **Refresh** button waits for a newer snapshot; if the gateway does not offer these endpoints, omit this block and the widget honestly shows session telemetry only.
