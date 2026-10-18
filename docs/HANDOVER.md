# TCOE TestPilot — Handover

This document covers running the tool end to end, giving it a manual test case,
how it discovers and reuses existing framework code, how to review what it
proposes, and how to validate the result.

---

## 1. Install and check

```bash
cd TCOE-TestPilot
npm install
npm run check
```

`npm run check` runs the typecheck and the test suite. Neither requires a model
provider or a network call.

---

## 2. Give it a manual test case

### The input format

Two text formats are supported. `detect()` tries them in order — Markdown
first, then plain text — and tells you which one it used.

**Plain text** — title on the first line, steps numbered, expected result
inline after an arrow:

```text
Log in and verify the dashboard loads
Precondition: A valid QA user exists in the system

1. Navigate to the login page → expected: The login form is visible
2. Enter the username | admin
3. Enter the password → expected: The value is masked
4. Click Login → expected: The dashboard is shown
```

**Markdown** — title as an `#` heading, steps under a `## Steps` heading:

```markdown
# Log in and verify the dashboard loads

## Steps

1. Navigate to the login page
2. Enter the username
   |test data| admin
3. Click Login
   > expected: The dashboard is shown
```

The rules the parser follows:

- **Title** — plain text: the first non-empty, non-numbered line. Markdown: an
  `#` heading.
- **Preconditions** — everything between a `Precondition:` / `Preconditions:` /
  `Given:` / `Setup:` line and the next blank line (plain text), or the body of
  a `## Preconditions` section (Markdown). Preconditions never become steps.
- **Steps** — `1. ` or `1) ` plus text. Steps keep their source order, and
  non-consecutive numbering produces a warning rather than being renumbered.
- **Expected result** — plain text: `→ expected: X` on the step line, or an
  `expected: X` line under the step. Markdown: a blockquote beginning with
  `expected` / `verify` / `ensure` / `result`.
- **Test data** — `|test data| value` attached to the step above it, or
  `… | value` at the end of a plain-text step line.

Anything the parser had to guess is recorded in
`testCase.source.assumptions`, and every problem it found is reported as a
`TestCaseIssue` with a suggestion. Nothing is silently dropped.

### Other formats

| Flag | Format |
| --- | --- |
| `--file ./case.md` | Markdown or plain text |
| `--file ./case.xlsx` | Excel, one sheet, columns for title / preconditions / step / expected / test data |
| `--file ./case.csv` | The same columns as CSV |
| `--stdin` | Pipe the case in |
| `--text "..."` | Pass it inline |

If no adapter can parse the content, `detect()` returns a null test case and an
error issue naming the formats it supports. It does not fall back to guessing.

---

## 3. Run the pipeline

### Step 1 — discover the framework

```bash
npm run cli -- analyze --repo ../TCOE-Playwright-Framework
```

Read this first. It tells you what the agent believes exists:

- architecture (which directories hold what)
- page objects and their files
- locators, with the actual Playwright expression
- action facade and its namespaces, e.g. `validation.expectVisible`
- fixtures, decorators, test data modules
- conventions marked **CONFIRMED** (found in code) vs **INFERRED** (guessed
  from structure)

Only CONFIRMED items should be trusted as binding.

### Step 2 — plan

```bash
npm run cli -- plan --repo ../TCOE-Playwright-Framework --file ./case.md
```

To explicitly capture page-level browser context, add `--browse --target-url <url>`.
The URL must not contain credentials. Browser evidence is shown separately from step
mapping; it does not by itself verify a selector for any individual step.

Prints a per-step plan and **stops**. No file is written. The task is saved to
`../TCOE-Playwright-Framework/.tcoe-testpilot/<taskId>.task.json`.

Each plan entry says one of:

| Resolution | Meaning |
| --- | --- |
| `existing-action` | Maps to a method already on the action facade |
| `existing-method` | Maps to a method on a page object |
| `existing-locator` | Maps to an existing locator |
| `assertion` | Needs an assertion, using the existing action surface |
| `new-method` | **Gap** — the framework has nothing for this step |

Every entry carries `evidence`: the matched symbol, its `file:line`, why it
scored that way, and the score against the threshold.

### Step 3 — generate

```bash
npm run cli -- generate <taskId> --repo ../TCOE-Playwright-Framework
```

Runs the deterministic framework-standard emitter using the approved plan and
current framework analysis, then stores the proposal as `proposedChanges` on
the task. **Still writes nothing.** Review unresolved locator TODOs carefully.

### Step 4 — apply

```bash
npm run cli -- apply <taskId> --repo ../TCOE-Playwright-Framework --dry-run
npm run cli -- apply <taskId> --repo ../TCOE-Playwright-Framework
```

The dry run prints the unified diff and writes nothing. The real run writes.

### Step 5 — validate

```bash
npm run cli -- validate <taskId> --repo ../TCOE-Playwright-Framework
```

Runs the framework's own `tsc --noEmit` and lint, plus TestPilot's own checks:
path containment, "only the approved files changed", and "every change has a
reason and evidence".

---

## 4. How reuse discovery works

This is the mechanism worth understanding, because it is the whole value of the
tool.

### The index

`analyze` walks the framework, skipping `node_modules`, build output, and
credential files. Every TypeScript file is parsed with the real TypeScript
compiler API — not a regex — and produces an index of:

- classes that extend a page-object base, or that live under a page directory
- locator classes and each locator field with its exact Playwright expression
  and the strategy used (`getByRole`, `getByPlaceholder`, `css`, …)
- methods on the action facade and each action group class, with parameter names
  and types
- custom fixtures
- tests, with their describe block, Xray key, referenced symbols, and whether
  the body contains an assertion

The index is cached at `.tcoe-testpilot/framework-index.json` as a file
fingerprint list. Next run, only changed files are re-parsed. If the framework
changed since the last run, the report says so.

### Scoring a step

For each manual step, `reuse-analyzer.ts` scores every indexed method against
the step's action text and expected result, and every locator against the action
text. The score is a deterministic combination of vocabulary overlap and
structural signals — method name tokens against step tokens, whether the step's
verb matches a known action verb, whether a locator's owner class matches the
page object the step implies.

A step resolves to an existing symbol when the best candidate scores at or above
`0.45` (`REUSE_SCORE_THRESHOLD` in
[reuse-analyzer.ts](../packages/repo-intelligence/src/reuse-analyzer.ts)).

Below that threshold, the step is reported as a gap with an explicit
`unresolvedReason`. It is never silently assigned to the nearest method.

### Duplicate detection

Before planning, existing tests are scored against the whole case. A high match
sets the decision to `update-existing` instead of `create-new`, and the
overlapping test is named in the report. This is how you avoid the agent
writing a second copy of a test that already exists.

### What the plan looks like

A realistic entry for a login step against a framework that already has the
method:

```
- **Step 4**: Click Login
  - Resolution: existing-action
  - Target: login.clickOnLoginButton
  - File: src/helper/actions/login.actions.ts:42
  - Evidence: "Method "login.clickOnLoginButton" at src/helper/actions/login.actions.ts:42
              verb "click" matches action verb; score 0.78 (threshold 0.45).
```

That step produces **no new code**. Only `new-method` and `assertion` entries
cause code to be written, and the plan says so explicitly.

---

## 5. Reviewing what is proposed

**Review the plan before generating.** This is the cheapest place to catch a bad
resolution, because nothing exists yet. Look for:

- steps resolved to a method whose name does not really match the step
- steps marked `new-method` that you expected the framework to cover — this
  usually means the method has a different name than you assume
- steps marked `unresolved`

**Review the diff before applying.** `--dry-run` prints it. Check that:

- the file created is the one the plan named
- no existing file was modified that the plan did not name
- every method, locator, and fixture referenced actually exists in the framework
- the test carries its Xray key and uses the framework's custom fixture import

`apply` refuses two situations rather than guessing: a change declared `create`
when the file exists, and `modify` when it does not. Both are reported in the
`skipped` list with a reason.

---

## 6. Validating an updated test

```bash
npm run cli -- validate <taskId> --repo ../TCOE-Playwright-Framework
```

Report sections:

| Section | What it checks |
| --- | --- |
| Paths | Every changed path resolves inside the repository |
| Unrelated files | Only files named in the plan changed |
| Diff | Every change has content, a reason, and evidence |
| Typecheck | `npx tsc --noEmit` in the framework |
| Lint | The framework's own lint script |

A failing check names the exact command and its output. `analyseFailure` maps a
Playwright failure to the likely cause — locator not found, assertion timeout,
fixture error, auth failure — so a red run tells you which of those it was
rather than just pasting a stack.

Then run the test itself:

```bash
cd ../TCOE-Playwright-Framework
npx playwright test --project=chromium -g "Log in and verify the dashboard"
```

Running against the real SAP S/4HANA system needs credentials and a reachable
system, so TestPilot cannot do that part for you.

---

## 7. State and artifacts

| Path | Contents |
| --- | --- |
| `TCOE-Playwright-Framework/.tcoe-testpilot/framework-index.json` | File fingerprints for staleness detection |
| `TCOE-Playwright-Framework/.tcoe-testpilot/<taskId>.task.json` | Task record: stages, plan, proposed changes, model calls |
| `TCOE-Playwright-Framework/.tcoe-testpilot/<taskId>.checkpoint.json` | Repository state at approval time, for drift detection |

Add that directory to the framework's `.gitignore` — it is derived state, not
source.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Model provider "openai-compatible" is unavailable` | The API key env var is not set | Export it, or pass `--api-key-env` with the correct name |
| Every step is `new-method` | The framework uses vocabulary the scorer does not recognise | Check `analyze` output; add terms to the scorer in `reuse-analyzer.ts` |
| `Task not found` | Wrong state dir | Pass `--state-dir` explicitly |
| `is in status "…", not "AwaitingApproval"` | You are running `generate`/`apply` out of order | Run `plan` first |
| `Path resolves outside the repository root` | The provider proposed a path outside the framework | This is the containment guard working. Reject it and fix the plan. |
| Test fails on login | Missing or wrong test credentials | Configure them in the framework; TestPilot does not handle secrets |

---

## 9. Extending

- **New input format** — implement `TestCaseAdapter` in
  [packages/adapters](../packages/adapters), register it in `index-builder.ts`.
- **New provider** — implement `ModelProvider` in
  [packages/provider-abstraction](../packages/provider-abstraction), register in
  `provider-registry.ts`.
- **Better reuse matching** — extend `scoreMethods` in
  [reuse-analyzer.ts](../packages/repo-intelligence/src/reuse-analyzer.ts). This
  is the right place for framework-specific vocabulary.
