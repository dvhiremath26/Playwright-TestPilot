# Test Plan

Current verified state: **154 tests passing across 12 files, typecheck clean** (`npm run check`).

```
tests/unit/adapters.test.ts           12 tests
tests/unit/workspace.test.ts           9 tests
tests/unit/apply-validate.test.ts     16 tests
tests/integration/framework-analysis.test.ts  12 tests
packages/browser-tools/tests/browser-orchestrator.test.ts  10 tests
packages/browser-tools/tests/browser-session-factory.test.ts  1 test
packages/browser-tools/tests/framework-standard-emitter.test.ts  13 tests
packages/browser-tools/tests/plan-emission.test.ts  12 tests
packages/browser-tools/tests/redaction-helpers.test.ts  9 tests
packages/provider-abstraction/tests/vscode-lm-provider.test.ts  16 tests
apps/vscode-extension/src/extension-config.test.ts  16 tests
```

## Commands

There is no build step for the agent; TypeScript runs directly under Node's type-stripping flag.

```bash
npm run typecheck        # tsc --noEmit across the workspace
npm run test             # vitest run — all suites
npm run test:unit        # tests/unit only
npm run test:integration # tests/integration only
npm run check            # typecheck then test
```

## Why the test split

`repo-intelligence` is the highest-risk code in the project. Its failures are silent: a parser
that swallows an exception produces a plausible-looking but empty index, and every downstream
score is then wrong. That is why the integration suite runs against a representative fixture tree
and asserts that symbols, locators, fixtures, namespaces, and conventions are actually recovered
— not just that the module loads.

Two of the eight defects found in validation were invisible to the earlier tests, which is the
reason for this structure:

- the symbol extractor discarded every TypeScript symbol when one error fired
- the fixture matcher never recognized multi-line worker-scoped fixtures

Both had "passing" unit tests that only checked the happy path of the function, never whether
realistic framework files actually produced symbols.

## Test strategy per layer

| Layer | Approach | Rationale |
|---|---|---|
| Adapters | Table-driven over formats | Detection is the first thing that can misroute a run; every branch needs a case. |
| Repo intelligence | Integration tests against fixture trees | Silent empty-index failures are the failure mode that matters most here. |
| Apply / validate | Unit tests with real temp dirs | Path containment and snapshot behavior must hold on the filesystem, not in memory. |
| Provider | Interface-level tests only | Network calls are excluded. See the gap below. |
| CLI | Manual runs against the real framework | Not automated; see gaps. |

## Real-framework smoke run

The suite does not exercise the tool against the actual `TCOE-Playwright-Framework`. That is a
manual step:

```bash
npm run cli -- plan --repo ../TCOE-Playwright-Framework --read-only \
  --state-dir ./tmp-smoke --file examples/material-document.case.txt
```

Use `--read-only` so the index is not written into the framework repository. Check that the plan
cites only paths that exist. Before validation, this surfaced the mock provider fabricating paths
that do not exist in the framework — something no automated test would have caught, because the
mock's own interface contract was satisfied.

## Gaps

- **Real model integration is untested.** No live endpoint or key is available here, so
  `openai-compat-provider.ts` has never made a real request. Timeouts, retries, and backoff are
  compiled but not exercised.
- **No end-to-end application test.** `tests/e2e` does not exist. A full plan → review →
  generate → apply → validate run against a real target has not been exercised.
- **Playwright execution is skipped by design.** `validate --run-tests` was never run; it needs a
  live SAP S/4HANA system and credentials the agent does not hold. The check is recorded as
  skipped with a reason rather than as passed.
- **CLI commands are not tested.** Only the library they call is.
- **Reuse thresholds are unvalidated.** The `0.45` score threshold and intent weights were set by
  inspection against a single sample case. They need validation across more cases.
- **Discovery completeness is unverified.** A real-framework run indexed 176 action methods but
  only 2 tests and 4 locators. That may be accurate for a data-driven framework, or it may be a
  discovery gap. Not yet established.
