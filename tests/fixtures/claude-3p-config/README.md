# Claude Desktop 1.20186.1 — third-party gateway config fixture

Captured evidence for the **exact local config-library representation** that
Claude Desktop 1.20186.1 writes to and loads from for third-party (custom-3p)
gateway inference. All secrets are placeholders — **never** commit a real
gateway token here.

## Definitive answer: the local active-config file is **FLAT**

The per-config file `<uuid>.json` under `configLibrary/` stores **flat keys**
(`inferenceProvider`, `inferenceGatewayBaseUrl`, `inferenceGatewayApiKey`,
`inferenceCredentialKind`, `inferenceGatewayAuthScheme`, `modelDiscoveryEnabled`,
`inferenceModels`). It is **NOT** nested. The nested shape
(`inference:{provider,baseUrl,credential:{kind,apiKey,authScheme}}`,
`models:{...}`) exists only as an *in-memory* Zod representation used for
validation/summary; it is never what lands on disk for the config-library file.

- The **loader** iterates the flat allow-list `Vf` and reads flat keys directly.
- The **writer** persists the caller's flat input object verbatim.
- Every flat key carries a `nestedPath` used only for the in-memory
  unflatten/flatten round-trip, never for disk persistence.

All line numbers below refer to the read-only extracted asar:
`app.asar` -> `.vite/build/index.chunk-c42vKsva.js`
(re-extract read-only if absent; do not modify the installed package).

## File paths & directory layout

| Item | Builder fn | Evidence |
| --- | --- | --- |
| userData root (honours `CLAUDE_USER_DATA_DIR`) | `W0()` | `index.chunk-c42vKsva.js:59817` — `if (process.env.CLAUDE_USER_DATA_DIR) return app.getPath("userData")`; win32 fallback `join(LOCALAPPDATA, "Claude-3p")` (`k$t = "Claude"+"-3p"`, line 59815) |
| `configLibrary/` dir | `K4()` | `index.chunk-c42vKsva.js:59828` — `join(W0(), "configLibrary")` |
| `<uuid>.json` path | `jS(e)` | `index.chunk-c42vKsva.js:59831` — `join(K4(), \`${e}.json\`)` |
| `_meta.json` path | `vte()` | `index.chunk-c42vKsva.js:59834` — `join(K4(), "_meta.json")` |
| `claude_desktop_config.json` path | `YNe()` | `index.chunk-c42vKsva.js:59824` — `join(W0(), ZNe)`, `ZNe="claude_desktop_config.json"` (line 59816) |

## `_meta.json` shape — `{ appliedId, entries:[{id,name}] }`

- **Reader:** `Xnt()` — `index.chunk-c42vKsva.js:59959` — `JSON.parse(readFileSync(vte()))`.
- **Writer:** `UE(e)` — `index.chunk-c42vKsva.js:59966` — mutates `{appliedId, entries}` then `Rt(vte(), t)`.
- **Default/self-heal:** `lB()` — `index.chunk-c42vKsva.js:59983` — when empty sets
  `appliedId = <uuid>`, `entries = [{ id: <uuid>, name: "Default" }]` (line 59990).
- **Validator:** `index.chunk-c42vKsva.js:57311` — requires `appliedId` to be a string;
  id regex `^[a-f0-9-]{36}$` (`JNe`, line 59827).

## Active-config `<uuid>.json` shape — FLAT

- **Loader:** `Jue(e)` — `index.chunk-c42vKsva.js:59997` —
  `JSON.parse(readFile(jS(e)))` then `l7(t, { onInvalid })`.
- **Flat-key transform:** `l7(e, t)` — `index.chunk-c42vKsva.js:71936` —
  iterates `t.allowedKeys ?? Vf` and reads `r[i]` (each flat key). It does **not**
  read nested `inference.*` / `models.*` paths from disk.
- **Flat allow-list:** `Vf = Object.keys(ml.shape)` — `index.chunk-c42vKsva.js:71722`
  (`ml` is the flat schema).
- **Writer:** `UQ(e, t, r)` — `index.chunk-c42vKsva.js:206033` — validates a flattened
  copy `KS(xre(mN(t)))` with `ml.safeParse`, then `cB(e, t)` persists the **raw flat
  input `t`** (line 206043).
- **Write helper:** `cB(e, t)` — `index.chunk-c42vKsva.js:205980` —
  `Rt(jS(e), t)` (writes object as-is to `<uuid>.json`).
- **Flat input normalizer:** `ede(e) = i4e(e, {scope:"3p"})` —
  `index.chunk-c42vKsva.js:206657` / `i4e` at `71948` copies flat keys directly
  (`r[i] = o`), dropping empty values. No nesting introduced.
- **Proof the writer is called with flat keys:** `fit()` calls
  `UQ(r, { inferenceProvider: "anthropic" })` — `index.chunk-c42vKsva.js:206846`.

### Why the nested shape is in-memory only

- `mN(e)` (unflatten) — `index.chunk-c42vKsva.js:72259` — builds nested
  `{inference:{...}, models:{...}}` from flat keys for validation.
- `KS(e)` (flatten) — `index.chunk-c42vKsva.js:72250` — collapses nested clusters
  back to flat keys.
- `Pre(e)` (nested `{provider, baseUrl, credential}`) —
  `index.chunk-c42vKsva.js:72170` — used only for the config-list **summary**
  (`yvr` -> `bvr`, lines 206006/206023), not for persistence.
- Flat<->nested map `D6` — `index.chunk-c42vKsva.js:71562` — e.g.
  `inferenceProvider` -> `nestedPath:["inference","provider"]`,
  `inferenceCredentialKind` -> `["inference","credential","kind"]`.

## Exact flat key names (evidence)

| Flat key | Evidence | Notes |
| --- | --- | --- |
| `inferenceProvider` | `index.chunk-c42vKsva.js:71502` (`flatKey`) | enum incl. `gateway`; setting it activates 3p mode |
| `inferenceCredentialKind` | `index.chunk-c42vKsva.js:71526` | enum: `static`, `helper-script`, `interactive`, `vendor-profile`, `oauth`, `workforce` (labels lines 71533-71550) |
| `inferenceGatewayBaseUrl` | `index.chunk-c42vKsva.js:68778` | provider `gateway` (`NPt`, line 68775) |
| `inferenceGatewayApiKey` | `index.chunk-c42vKsva.js:68719` | credential `kind:"static"` (`FPt`, line 68715) |
| `inferenceGatewayAuthScheme` | `index.chunk-c42vKsva.js:68689` | enum `bearer` \| `x-api-key`; default `bearer` (line 68692); `auto`->`bearer`, `sso`->undefined (line 68685) |
| `modelDiscoveryEnabled` | `index.chunk-c42vKsva.js:70150` | boolean |
| `inferenceModels` | `index.chunk-c42vKsva.js:70200` | array of model items (below) |
| `coworkTabEnabled` | `flatKey:"coworkTabEnabled"`; `support:{enabled:{scopes:["3p"],availableInVersion:"1.9659.0"}}` | surface toggle; default-ENABLED (only off when explicitly `false`) |
| `isClaudeCodeForDesktopEnabled` | `flatKey:"isClaudeCodeForDesktopEnabled"`; `support:{scopes:["3p","1p"],availableInVersion:"1.2581.0"}` | surface toggle; default-ENABLED |
| `chatTabEnabled` | `flatKey:"chatTabEnabled"`; `support:{scopes:["3p"],availableInVersion:"1.13576.0"}`; `betaFeatureKey:"chatTab"` | surface toggle; default-DISABLED unless explicitly `true` |

### Surface toggles are FLAT config-library keys (not `claude_desktop_config.json`)

The three tab surfaces are FLAT keys on the same flat schema `ml.shape` (read via
the flat allow-list `Vf`) — i.e. they live in `configLibrary/<uuid>.json`
alongside `inferenceProvider`, NOT in `claude_desktop_config.json`. The client's
surface-normalizer reads them off the SAME flat object `r`:

```
r.coworkTabEnabled===false && r.isClaudeCodeForDesktopEnabled===false && r.chatTabEnabled!==true
  -> onWarn("At least one surface must remain enabled; the Cowork tab has been re-enabled."), r.coworkTabEnabled=true
```

So Cowork + Code are default-ENABLED (only disabled when explicitly `false`), and
Chat is default-DISABLED unless explicitly `true`. Setting `chatTabEnabled:true`
in this flat file yields **Chat + Cowork + Code** for the 3P path.

> HONEST LIMIT: the unified **Home** layout is a FIRST-PARTY claude.ai REMOTE
> feature the offline 3P bundle cannot render; SSH remote is likewise
> first-party-only. Neither is fixable via the gateway/3P config. Chat + Cowork +
> Code is the best achievable surface set.

## Model list location & item field names

- **Location:** flat key **`inferenceModels`** (array), NOT `models.list` and NOT
  `inference.models`. Evidence: `index.chunk-c42vKsva.js:70200` (`flatKey:"inferenceModels"`),
  runtime use at `206662` (`t.inferenceModels`) and `72015`.
- **Model item schema** `aTt` — `index.chunk-c42vKsva.js:70054`:
  - `name` — required, primary key, the exact model ID the app sends (line 70055-70059).
  - `labelOverride` — optional display name shown in the picker (line 70061-70079).
  - `supports1m` — optional bool, 1M-context variant (line 70080).
  - `anthropicFamilyTier` — optional tier alias `haiku|sonnet|opus|fable|mythos` (line 70091).
  - `isFamilyDefault` — optional bool, default-for-tier (line 70108).
  - Confirmed rendering uses `labelOverride ?? name` (lines 78555, 78951).

## deploymentMode persistence

- Persisted in **`claude_desktop_config.json`**, NOT in the config-library file.
- Writer `zh(e, t)` — `index.chunk-c42vKsva.js:137254` — reads `YNe()`
  (`claude_desktop_config.json`), sets `s[Ire] = e` where `Ire = "deploymentMode"`
  (`index.chunk-c42vKsva.js:73352`), value enum `["3p","1p"]`
  (`index.chunk-c42vKsva.js:65019`), then writes back (line 137270).

## Files in this fixture

- `_meta.json` — exact meta shape, placeholder UUID + name `"Default"`.
- `00000000-0000-0000-0000-000000000000.json` — exact FLAT active-config shape,
  placeholder gateway `http://127.0.0.1:PORT`, credential kind `static`, the
  gateway-api-key field set to the placeholder string `EPHEMERAL_LOOPBACK_TOKEN`
  (a placeholder — not a real secret), auth scheme `bearer`, and `inferenceModels`
  with 2 example entries using the client's real field names (`name` +
  `labelOverride`).

## Capture method note

The Developer -> Configure third-party inference flow is driven via IPC
(`Custom3pSetup.setDeploymentMode`, `index.chunk-c42vKsva.js:59053`) and cannot be
completed headlessly without a human at the sign-in/UI step, so the schema was
pinned from the read-only extracted `app.asar` writer/loader functions cited
above rather than by faking a client write. The live machine state was verified
read-only: `%LOCALAPPDATA%\Claude-3p\configLibrary\_meta.json` matches the
`{appliedId, entries:[{id,name}]}` shape and the active `<uuid>.json` is `{}`.
