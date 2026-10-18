# Model Provider Abstraction

The agent calls a model through a stable interface so the framework analysis, scoring, and plan
structure never depend on which provider answers. Swapping providers does not change what gets
discovered or how it is scored — only how the plan text is worded.

## The interface

Defined in `packages/shared-types/src/provider.ts` and implemented by each provider:

- `check()` — is this provider usable right now?
- `listModels()` — which models does it offer?
- `selectDefault()` — which model should be used when none is configured?
- `chat(messages, options)` — produce a response for a purpose (`plan` or `generation`).

`packages/provider-abstraction/src/provider-registry.ts` resolves a provider id to an
implementation.

## Providers

### `mock` — default, offline, deterministic

Picks `mock` when no config exists. Produces plan-shaped text, never code, and always labels its
output `confidence: inference`.

It is deliberately incapable of inventing evidence. It parses the step plan the analyzer already
computed and echoes only what was discovered — method names, file paths, and resolutions. When a
resolution claims an existing symbol but the analyzer recorded none, it says so explicitly rather
than supplying a plausible path.

An earlier version of this provider hardcoded `auth.login`, `form.fillField`, `navigation.goTo`,
and file paths such as `src/helper/actions/form-actions.ts`. None of those exist in the target
framework. That was a real defect: fabricated evidence reads as verified to a reviewer.

### `openai-compatible`

A minimal chat-completions client built only on Node builtins (`packages/provider-abstraction/src/openai-compat-provider.ts`).

Implements: configurable base URL, `/models` listing, chat completions, request timeout with
`AbortController`, retry with exponential backoff, and abort propagation from the caller's
`AbortSignal`.

**This path has never run against a live endpoint.** It is compiled and covered by the provider
unit tests only at the interface level. Treat integration as unverified until someone has exercised
it with a real key.

### `vscode-lm` — VS Code extension host

The extension adapts VS Code's Language Model API through `createCopilotBridge()` and injects
that bridge into the shared runner. It is unavailable from a standalone CLI process. The provider
unit tests cover the bridge contract, but live Copilot discovery and a real request still need to
be checked in a VS Code extension host.

## Configuration

Config is merged in this priority order, later sources winning: defaults → config file →
environment → programmatic overrides.

| Field | Meaning |
|---|---|
| `provider` | `mock`, `openai-compatible`, or `vscode-lm` (extension host only). Default `mock`. |
| `model` | Model id, e.g. `gpt-4o`. |
| `baseUrl` | OpenAI-compatible endpoint. |
| `apiKeyEnvVar` | **Name** of the environment variable holding the key. |
| `timeoutMs` | Per-request timeout. |
| `maxRetries` | Retries on transient failure. |
| `temperature` | 0–2, validated. |
| `approvalMode` | `manual` (default) or `auto`. |

Environment overrides use the `TCOE_` prefix: `TCOE_PROVIDER`, `TCOE_MODEL`, `TCOE_BASE_URL`,
`TCOE_API_KEY`, `TCOE_TIMEOUT_MS`, `TCOE_MAX_RETRIES`, `TCOE_TEMPERATURE`, `TCOE_APPROVAL_MODE`.

## Key handling

Secrets are resolved from environment variables only. The config object never holds a literal key.

In `tcoe-testpilot.config.json`, the key is referenced by name:

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4o",
  "apiKey": "env:OPENAI_API_KEY",
  "timeoutMs": 60000,
  "maxRetries": 2,
  "approvalMode": "manual"
}
```

The `env:` prefix is load-bearing. `loadFromFile` reads the `apiKey` field and converts it to an
`apiKeyEnvVar` **only** when it starts with `env:`. Any other value is discarded silently — a
literal key pasted into the config file is never loaded, so it cannot reach a log or an error
message by accident. Only `TCOE_API_KEY` in the environment is read for that field.

`config --show` prints the resolved config with secrets masked.

## Approval

`approvalMode: manual` (the default) makes the CLI print the plan and stop. Nothing is written
until a human approves it. `auto` runs generation and application without prompting.

Manual is the default because the generated code lands in a framework other engineers maintain.
The value of the tool is the reviewed plan with evidence, not unattended code.

## Constraints on what the model may produce

The  in `packages/provider-abstraction/src/prompts.ts` enforces the PROMPT.md rules
on any real model: never emit code before approval, never use a method name not present in the
supplied facts, never paraphrase a manual step, and never fabricate evidence.

These are prompt-level constraints, not enforcement. The deterministic layers are what actually
prevent fabricated paths from reaching disk: the analyzer only reports symbols it parsed, and
`apply.ts` refuses paths outside the repository root.
