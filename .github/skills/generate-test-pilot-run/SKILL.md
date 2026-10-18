---
name: generate-test-pilot-run
description: >
  Run TCOE TestPilot to turn a manual test case into a Playwright TypeScript test
  inside TCOE-Playwright-Framework, reusing that framework's existing page objects,
  locators, and action facade. Use when asked to generate, update, or plan an
  automated test from a manual test case, to check whether the framework already
  covers a step, or to validate a test TestPilot produced.
---

# Run TCOE TestPilot

Goal: finish with the **smallest diff that reuses what already exists**, and never
write a byte into the target repository before a human has approved the plan.

Repository-wide rules (the plan-first stages, the evidence requirement, the write
boundaries) live in `.github/copilot-instructions.md`. Read the relevant section
rather than working from this file alone.

---

## Stage 0 — Ask what you actually have

Establish which of these you were given before running anything:

- **A manual test case** — a business description with ordered steps.
- **A file path** — `case.md`, `case.xlsx`, `case.csv`, or a Jira export.
- **Free-form prose** — pasted into the conversation.

If the case has no Xray key, say so and ask for one. The framework's `xray()`
decorator throws on a malformed key, and inventing one silently breaks the
Xray round-trip.

---

## Stage 1 — Analyze the framework

```bash
npm run cli -- analyze --repo ../TCOE-Playwright-Framework
```

Read the report before going further. It is the ground truth for everything
after this.

Pay attention to the split between **CONFIRMED** conventions (found in code) and
**INFERRED** ones (derived from directory structure). Only CONFIRMED items are
binding. If an INFERRED item contradicts what you see in the source, trust the
source.

If the report says the index is stale, the framework changed since the last run;
re-run before planning so the plan is built on current code.

---

## Stage 2 — Produce the plan

```bash
npm run cli -- plan --repo ../TCOE-Playwright-Framework --file ./case.md
```

This writes nothing to the framework. It saves a task record and prints a
per-step plan.

**Stop here and present the plan to the user.** Do not proceed to generate.

Each entry is one of `existing-action`, `existing-method`, `existing-locator`,
`assertion`, `new-method`. Show the user:

- the step and its resolution
- the target symbol and `file:line` for anything resolved to existing code
- every `new-method` entry, with the reason the framework has no match
- any `unresolvedReason`

Surface these specific concerns rather than a summary:

1. **A `new-method` the user expected to be covered.** Usually the framework
   already has the method under a different name. Check the analyze output before
   accepting the gap.
2. **A weak resolution.** A match at exactly the threshold is worth questioning.
3. **An `update-existing` decision.** Check that the test named as a duplicate is
   genuinely the right one to extend.

---

## Stage 3 — Generate

Only after the user approves.

```bash
npm run cli -- generate <taskId> --repo ../TCOE-Playwright-Framework
```

This produces file content and stores it on the task. **Still writes nothing.**

If the output says zero files were produced, the provider response could not be
parsed as file blocks. Report that as-is. Do not retry with a different prompt and
present the result as success.

---

## Stage 4 — Review the diff

```bash
npm run cli -- apply <taskId> --repo ../TCOE-Playwright-Framework --dry-run
```

Prints the unified diff, writes nothing. **Show the diff to the user and stop.**

Check, in this order:

- Is the created file the one the plan named?
- Did anything get modified that the plan did not name?
- Does every referenced method, locator, and fixture actually exist in the
  framework, at the cited `file:line`?
- Does the test import `test` and `expect` from `@src/config/fixture` and **not**
  from `@playwright/test`?
- Does the test carry its Xray key?
- Are credentials referenced through `CredentialManager` / `DataLoader` rather
  than written literally?

If `apply` reports anything under `skipped`, tell the user which change was
refused and why. Do not work around a refusal by editing the plan to match the
file on disk — that inverts the safety check.

---

## Stage 5 — Apply

```bash
npm run cli -- apply <taskId> --repo ../TCOE-Playwright-Framework
```

Only after the user has reviewed the diff and said yes.

---

## Stage 6 — Validate

```bash
npm run cli -- validate <taskId> --repo ../TCOE-Playwright-Framework
```

Report each check by name and its actual output. A failing typecheck or lint is a
failure; do not summarise it as "mostly clean".

Then the real run, which needs credentials and a reachable SAP system:

```bash
cd ../TCOE-Playwright-Framework
npx playwright test -g "<test title>"
```

**If you cannot run it, say so explicitly.** A test that typechecks is not a
test that passes.

---

## Recovering from a failed run

`analyseFailure` maps a Playwright failure to a cause — locator not found,
assertion timeout, fixture error, auth failure. Use that classification, then:

- **Locator not found** — the element is absent or the selector is wrong. Prefer
  role/label over CSS; check whether the page object already has a locator for it.
- **Assertion timeout** — the interaction probably succeeded but the expected text
  did not appear. For Fiori, prefer `actions.wait.untilText(...)` over a fixed
  timeout.
- **Auth failure** — a config or credential problem, not a test defect. Say so
  rather than weakening the test.
- **Click intercepted** — suspect the WalkMe guided-tour overlay before the
  locator. The framework already blocks `WALKME_URL_PATTERNS` for this reason.

Never fix a failure by deleting the assertion.

---

## Never

- Never write to `TCOE-Playwright-Framework/` before an approved plan exists.
- Never invent a framework method. If it is not in the analyze report, it does not
  exist.
- Never invent an Xray key.
- Never write a credential, a `.env` value, or a decrypted secret into a file,
  output, or commit.
- Never run `git commit`, `git push`, `reset`, `clean`, `restore`, or `checkout .`.
- Never claim a test passed unless you ran it and saw it pass.