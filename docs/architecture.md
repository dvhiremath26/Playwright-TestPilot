# Architecture

TCOE TestPilot is a local-first TypeScript workspace with a CLI and a VS Code extension.
It analyzes an existing Playwright framework, creates a reviewable plan and proposed
framework-conformant files, and applies files only through an explicit user action.

## Package layout

| Package | Responsibility |
|---|---|
| `packages/shared-types` | Shared task, plan, provider, and validation contracts. |
| `packages/adapters` | Normalize text, Markdown, Jira-style, and Excel cases. |
| `packages/repo-intelligence` | Scan and index framework source; identify reuse and duplicates. |
| `packages/provider-abstraction` | Mock, OpenAI-compatible, and injected VS Code language-model providers. |
| `packages/browser-tools` | Playwright CLI and MCP adapters, browser session, and session factory. |
| `packages/cli` | Runner, CLI commands, deterministic emitter integration, apply, validate, and reporting. |
| `apps/vscode-extension` | VS Code commands, Copilot bridge, settings, and review UI. |

## Implemented run stages

`runAgent` executes `Understand` (normalize), `Observe` (index), `Retrieve` (reuse),
`Decide` (map steps), optional `Browse` (capture page context), then `Plan` (provider plan
narrative). It returns a task in `AwaitingApproval`; it does not write generated files.

The CLI persists that task and separates the remaining actions into `generate`, `apply`,
and `validate`. CLI generation uses the deterministic framework emitter. The VS Code
extension uses the selected Copilot model to generate the proposal from the approved plan,
framework index, and any selected browser locator evidence. It checks that a spec is
present and that every manual action appears in the proposed files. Apply enforces
repository path containment and create/modify expectations. Validation checks proposal
quality, paths, unrelated files, typecheck, lint, and optionally tests.

Browser observation is opt-in. In the extension, the user can inspect only the starting
page or explicitly follow the manual steps; the latter warns that it can enter supplied
test data and click controls. The target URL comes from settings or the first URL in the
manual steps. Follow Steps captures a snapshot after each step and generates locator
candidates from observed refs, scoped to that step and screen. Ambiguous or unsupported
actions are not replayed; the reviewer still maps a candidate before it becomes step
evidence. The CLI can configure MCP as a fallback; the extension does not yet expose or
configure that fallback. MCP cannot generate locator candidates.

## Provider boundaries

- `mock` is deterministic and offline.
- `openai-compatible` is available to the CLI through provider configuration; live use has
  not been verified in this project.
- `vscode-lm` is available through an injected bridge in the VS Code host; live Copilot use
  still requires extension-host verification.

The model produces planning narrative. The extension also uses the selected model to create
the proposed files; the CLI proposal path is deterministic. Official Playwright
Planner/Generator/Healer agents are not invoked by the current code. The `vscode.lm` bridge
is wired to `selectChatModels` and `sendRequest`, but live extension-host requests remain
unverified.

## Safety and remaining integration

Changes are proposals until the user invokes CLI `apply` or confirms the extension's modal
apply action. Target URLs containing userinfo are rejected. Browser inspection must be
explicitly requested.

Validation failures can produce up to two evidence-based repair proposals. Applying a
repair requires explicit approval and triggers re-validation. The official Playwright
Healer agent is not called. See [design-flow-diagram.md](design-flow-diagram.md) and
[ROADMAP.md](ROADMAP.md) for current verification and pending work.
