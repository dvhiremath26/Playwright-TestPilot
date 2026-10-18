# TCOE TestPilot — Repository Instructions

These instructions apply to the whole repository. They describe the non-negotiable
rules for anything that generates, edits, or reviews Playwright test code.

## 1. The plan-first rule

**Never write, edit, or delete a test file before a plan has been produced and a
human has approved it.** The stages are Understand → Observe → Retrieve → Plan →
Decide → Act → Verify → Recover → Report.

- Understand — normalize the manual test case; report validation errors before doing anything else.
- Observe — analyze the framework repository and build the discovery report.
- Retrieve — search for existing tests, helpers, page objects, locators, and fixtures.
- Plan — produce the structured plan. **This stage emits no code.**
- Decide — decide reuse / update / create-new / needs-clarification, with evidence.
- Act — write the approved file changes only.
- Verify — run the available checks and report honestly what ran.
- Recover — on failure, propose the smallest possible fix citing file and line.
- Report — summarize decisions, provenance, and every unresolved item.

If asked to skip the plan, respond with the plan and wait. The default
`approvalMode` is `manual`.

## 2. Reuse before create

The target framework is `TCOE-Playwright-Framework`. Treat it as read-only
unless a task explicitly approves a change to it.

Before generating any test:

1. Index the framework's reusable action methods, page objects, locators,
   fixtures, and test-data modules.
2. For **each** manual step, find the closest existing method.
3. Use only method names that actually appear in the index. Never invent a
   method name, never guess a locator, never assume a fixture exists.
4. A step with no plausible existing method is marked `unresolved` — say so
   rather than fabricating a match.

Confidence tiers used throughout:

| Tier | Meaning |
| --- | --- |
| `CONFIRMED` | Found directly in source. Cite `file:line`. |
| `INFERRED` | Reasoned from convention. Say it was inferred. |
| `UNRESOLVED` | No evidence. Do not guess. |

## 3. Every claim carries evidence

Every reuse decision, every proposed change, and every failure analysis must
cite a concrete source location: `path/to/file.ts:123`. A claim without a file
and line is not evidence — it is a guess, and it must be labelled as one.

## 4. Never fabricate an integration

- If a model provider is unreachable or unauthenticated, report it and stop.
  Do not fall back to fabricated output presented as a real model's work.
- If a validation check could not run, mark it `SKIP` with a reason. A check
  that never ran is never reported as a pass.
- If a test requires a live SAP S/4HANA system, say the test was not executed.
- The offline mock provider is allowed and useful, but its output must always be
  labelled as deterministic and unverified.

## 5. Write boundaries

Every file write goes through the workspace containment check. A path that
resolves outside the target repository — including through `..` or a symlink —
is refused, not sanitised and then used.

Never run destructive Git commands (`reset`, `clean`, `checkout .`, force push)
without explicit human authorization in the current conversation.

## 6. Secrets

- API keys are read from environment variables, named in config. They are never
  written to a file, never logged, never included in a plan or report.
- Every log line, error message, and telemetry payload passes through the
  redaction helper before it leaves the process.
- Never read `.env` files for credentials and never echo their values.

## 7. Style of generated tests

Follow the conventions the framework already demonstrates — do not impose a new
style. Specifically, confirm before generating whether the framework uses:

- a page-object per screen, and its naming convention;
- a `getByRole` / `getByLabel` locator strategy before CSS or XPath;
- an action facade with namespaces (e.g. `validation.expectVisible(...)`);
- a `@Step(...)` decorator or `test.step(...)` for logging;
- `DataLoader.get(moduleName)` for environment-specific test data.

When a convention cannot be confirmed from source, use the framework's own
existing spec files as the reference and say in the plan which file was used.

## 8. Testing rules

- Add tests for the agent itself, not for the generated output.
- A generated test is never committed as "passing" unless it was actually run.
- Prefer real assertions over mocks for the framework-analysis code, because
  that code is deterministic and its correctness is checkable offline.