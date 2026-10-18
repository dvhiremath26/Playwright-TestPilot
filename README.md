# TCOE TestPilot

An AI-assisted local tool that turns a **manual test case** into a reviewable,
framework-conformant Playwright TypeScript proposal. It includes a CLI and a VS Code
extension and reuses the target framework's existing page objects, locators, and action
facade instead of reinventing them.

Everything runs **locally**. No code leaves the machine unless you configure a
model provider yourself, and no file is written to the framework without your
explicit approval.

---

## How it works

The implemented workflow is:

```
 1  Understand  normalize and validate the manual test case    → structured TestCase
 2  Observe     scan + analyse the target framework            → framework index
 3  Retrieve    find duplicates and reusable code              → ReuseReport
 4  Decide      map steps to framework symbols                 → PlanEntry[]
 5  Browse      optional, explicit page snapshot               → page-level evidence
 6  Plan        produce plan narrative                         → AwaitingApproval
 7  Generate    selected Copilot model in VS Code; deterministic emitter in CLI → proposedChanges
 8  Apply       apply only after explicit user action          → files written
 9  Validate    containment, diff, typecheck, lint, optional tests → ValidationReport
```

Browser observations are not attributed to individual test steps. Locator candidates
remain unassigned until a reviewer maps them to steps. Validation failures can produce
up to two evidence-based repair proposals; each requires explicit approval before apply
and is validated again. TestPilot does not call the official Playwright Healer agent.

### The reuse requirement

Stage 3 is the point of the whole tool. For every manual step, the agent scores
the framework's real, indexed symbols — action methods, page-object methods,
locators, fixtures — and resolves the step to the best existing match. Steps that
resolve to an existing symbol produce **no new code**. A plan that invents a
`login.submit()` when `LoginPage.clickOnLoginButton()` already exists is the
failure mode this design exists to prevent.

---

## Requirements

- Node.js >= 20
- npm
- A model provider for plan narrative (offline `mock` by default; OpenAI-compatible in
  the CLI or GitHub Copilot through the VS Code extension)

---

## Setup

```bash
cd TCOE-TestPilot
npm install
```

### Configuring a model provider

Default is `provider: mock`, which never calls a network service. To use a real
OpenAI-compatible endpoint (OpenAI, Azure OpenAI, LiteLLM, Ollama, vLLM):

```bash
export OPENAI_API_KEY="..."
npm run cli -- plan --repo ../TCOE-Playwright-Framework --file ./case.md \
  --provider openai-compatible \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o \
  --api-key-env OPENAI_API_KEY
```

The API key is **never stored**. The config holds only the *name* of the
environment variable; the value is read at request time and redacted from every
log, report, and persisted task file.

---

## Usage

### Discover what the framework already offers

```bash
npm run cli -- analyze --repo ../TCOE-Playwright-Framework
```

Prints the detected architecture, page objects, locators, action methods,
fixtures, test data modules, and any conventions the analyzer is confident about.

### Give it a manual test case

Create `case.md`:

```markdown
# Log in and verify the dashboard loads

## Preconditions

A valid QA user exists

## Steps

1. Navigate to the login page
2. Enter the username
   |test data| admin
3. Enter the password
4. Click Login
   > expected: The dashboard is shown
```

Plain text works too — title on the first line, expected result inline:

```text
Log in and verify the dashboard loads
Precondition: A valid QA user exists

1. Navigate to the login page → expected: The login form is visible
2. Enter the username | admin
3. Click Login → expected: The dashboard is shown
```

Then:

```bash
npm run cli -- plan --repo ../TCOE-Playwright-Framework --file ./case.md
npm run cli -- resume <taskId> --repo ../TCOE-Playwright-Framework
```

This prints the **plan** and stops. Nothing is written to the framework. `resume`
reloads a saved task and checks its indexed source files and Git HEAD/branch before showing the next step.

### Read the plan carefully

The plan states, per step, whether it resolves to an **existing** framework
symbol (with `file:line`) or is a genuine **gap** that needs new code. This is
your chance to reject a bad resolution before any code exists.

### Generate and apply

```bash
npm run cli -- generate <taskId> --repo ../TCOE-Playwright-Framework
npm run cli -- map-locator <taskId> --step 2 --ref e15 --repo ../TCOE-Playwright-Framework
npm run cli -- apply <taskId> --repo ../TCOE-Playwright-Framework --dry-run
npm run cli -- apply <taskId> --repo ../TCOE-Playwright-Framework
npm run cli -- repair <taskId> --repo ../TCOE-Playwright-Framework
npm run cli -- apply <taskId> --repo ../TCOE-Playwright-Framework
```

`generate` produces file content but writes nothing. `apply --dry-run` prints
the unified diff. `apply` writes.

After a failed validation, `repair` creates a bounded, evidence-based proposal and
prints its diff. Applying that repair requires a separate `apply` command, which
then runs validation again.

### Validate

```bash
npm run cli -- validate <taskId> --repo ../TCOE-Playwright-Framework
```

Runs the repository's own checks (`npx tsc --noEmit`, lint) against the result,
plus containment and diff-review checks of its own.

---

## Where TestPilot writes

| Location | Contents | Committed? |
| --- | --- | --- |
| `TCOE-Playwright-Framework/.tcoe-testpilot/` | Framework index, task records, checkpoints | No — add to `.gitignore` |
| `TCOE-Playwright-Framework/tests/`, `pages/` | Only after `apply` | Yes, as your own change |

---

## Safety properties

These are enforced in code, not by convention:

- **Workspace containment.** Every path — including paths the model generated —
  is resolved through `Workspace.tryResolve`, which rejects parent traversal,
  absolute paths outside the root, symlinks pointing outside the root, and null
  bytes. A write is impossible through a verified escaping path.
- **No silent overwrite.** A change declared `create` against an existing file,
  or `modify` against a missing one, is skipped with a reason rather than
  guessed at.
- **Approval gates.** `generate` only runs from `AwaitingApproval`. `apply` only
  runs for an awaiting plan or a reviewed repair proposal. Both stop otherwise.
- **No credential exposure.** Keys live only in environment variables. Config
  dumps run through `redactObject`. Credential files are excluded from the scan.
- **Destructive operations** (Git commands, deletions) are never performed.

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run cli -- analyze --repo <path>` | Framework discovery report |
| `npm run cli -- plan --repo <path> --file <case>` | Normalise + analyse + plan |
| `npm run cli -- plan --repo <path> --file <case> --browse --target-url <url>` | Opt in to a page snapshot during planning |
| `npm run cli -- generate <taskId> --repo <path>` | Generate deterministic proposal files from the reviewed plan |
| `npm run cli -- apply <taskId> --repo <path>` | Write the approved changes |
| `npm run cli -- validate <taskId> --repo <path>` | Run checks against the result |
| `npm run cli -- repair <taskId> --repo <path>` | Propose a bounded repair after failed validation; requires a separate apply |
| `npm run typecheck` | Typecheck the workspace |
| `npm test` | Run the TestPilot test suite |
| `npm run check` | typecheck + tests |

---

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/shared-types` | Types shared across packages |
| `packages/repo-intelligence` | Scanning, TypeScript AST analysis, reuse scoring, duplicate detection, index & staleness |
| `packages/adapters` | Test-case ingestion: text, Markdown, Excel, Jira |
| `packages/provider-abstraction` | Model provider interface, OpenAI-compatible client, mock provider, prompts, redaction |
| `packages/browser-tools` | Playwright CLI/MCP adapters and opt-in page snapshots |
| `packages/cli` | The `testpilot` command: run, apply, validate, report |
| `apps/vscode-extension` | VS Code commands, Copilot bridge, plan and diff review UI |

---

## Extending

- **A new input format** — implement `TestCaseAdapter` in `packages/adapters`,
  register it in `index-builder.ts` with a priority.
- **A new model provider** — implement `ModelProvider` in
  `packages/provider-abstraction` and register it in `provider-registry.ts`.
- **A new reuse signal** — extend `reuse-analyzer.ts`; the scoring is isolated
  there and is the right place for heuristics about your specific framework.

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Package layout, current stages, providers and apply design |
| [docs/model-provider.md](docs/model-provider.md) | Provider interface, config precedence, key handling, `approvalMode` |
| [docs/test-plan.md](docs/test-plan.md) | Suite structure, commands, real-framework smoke run, known gaps |
| [docs/security.md](docs/security.md) | Secrets, path containment, destructive-operation gates, Git policy |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Verified implementation and remaining work |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Integration and verification work still pending |
| [docs/design-flow-diagram.md](docs/design-flow-diagram.md) | Current workflow and explicit implementation limits |
| [docs/HANDOVER.md](docs/HANDOVER.md) | Operating guide: how to run, approve, and validate a generated test |

## What is not built yet

Stated plainly rather than left for the reader to find:

- **Live model behavior is unverified.** The extension uses the selected Copilot model for planning and proposal generation, and the CLI supports configured providers, but live requests have not been checked against a real account in this project.
- **Live integrations remain unverified.** Copilot requires a running VS Code host; browser integration requires a reachable application and supported authentication state.
- **MCP locator generation is unsupported.** Playwright CLI creates locator candidates from observed refs; users explicitly map candidates to steps. MCP produces no locator candidates.
- **Repair uses TestPilot's bounded proposal flow.** It does not call the official Playwright Healer agent.
- **A full target-framework end-to-end run and larger reuse-quality evaluation remain pending.**
