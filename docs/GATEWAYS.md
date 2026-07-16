# Gateway compatibility

The gateway must expose `/v1/models` and at least one supported inference interface.

| Interface | Endpoint |
|---|---|
| Anthropic Messages | `/v1/messages` |
| OpenAI Chat Completions | `/v1/chat/completions` |
| OpenAI Responses | `/v1/responses` |

The adapter classifies routes from gateway metadata, saved conformance probes, and documented registry facts. It does not guess a protocol from a provider or model name. Models without a safe chat route stay unavailable.

## Authentication

- `bearer` sends `Authorization: Bearer …`
- `x-api-key` sends `x-api-key: …`
- `custom-header` sends the credential in the named header
- `none` is suitable only for a trusted loopback service

Remote URLs require HTTPS; HTTP is allowed only on loopback. Embedded URL credentials and reserved/secret-bearing custom headers are rejected. The saved JSON contains a Credential Manager reference, never the key.

Reverse proxies must preserve Server-Sent Events and final usage events. A gateway that accepts an unknown field with HTTP 200 has not proved that the field works; effort controls require stronger conformance evidence.
