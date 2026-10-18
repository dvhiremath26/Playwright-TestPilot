---
name: update-playwright-test
description: Inspect an existing Playwright TypeScript framework, then plan and safely update or create a test from a manual case or failure report.
---

# Update or add a Playwright test

Use this workflow when changing an existing test, adding a test from a manual case, or investigating a failed test. Follow `.github/copilot-instructions.md` for repository-wide safety rules.

1. **Understand the request.** Identify the test case or failure, application and workflow, expected business result, and any Jira/Xray key. Ask only for missing details that block a correct plan; never invent steps or identifiers.
2. **Inspect the target framework.** Confirm the configured repository and run `npm run cli -- analyze --repo <framework-path>`. Read the report and current source for the relevant tests, fixtures, page objects, locators, actions, test data, config, and validation scripts.
3. **Find reuse and overlap.** Search by test ID/key, title, workflow terms, and relevant methods. Inspect likely matches directly. Label similarity as evidence for review, not proof of duplication.
4. **Map each step.** Record the existing method/locator/fixture/assertion and its `path:line`, or mark the step unresolved. Separate confirmed source facts from inferred conventions. Browser snapshots are page-level evidence until a particular element is verified for a step.
5. **Present a concise plan.** Name the intended create/modify files, reused components, unresolved work, expected assertion, and reason for each change. Stop for human approval before writing to the target framework.
6. **Make the smallest change.** Preserve unrelated code, assertions, tags, test data patterns, and reporting. Do not add dependencies, guessed locators, invented helpers, arbitrary sleeps, or literal credentials.
7. **Review the proposal.** Inspect the full diff. Confirm every referenced symbol exists, each locator has evidence, and the test follows the framework's imports, naming, fixture, and assertion conventions.
8. **Validate what is safe and available.** Run the target framework's relevant typecheck/lint/test command only when permitted. Report exact commands and results; mark unavailable live SAP or credential-dependent runs as not run.
9. **Recover from evidence.** For failures, inspect actual output and source, then propose the smallest correction. Do not remove assertions or alter unrelated files to make a check pass.
10. **Report completion.** Summarize files changed, reuse decisions, validation actually performed, and remaining uncertainty or manual setup.

## TestPilot workflow

From this repository, use the CLI against the configured framework:

```sh
npm run cli -- plan --repo <framework-path> --file <case.md>
npm run cli -- resume <task-id> --repo <framework-path>
npm run cli -- generate <task-id> --repo <framework-path>
npm run cli -- apply <task-id> --repo <framework-path> --dry-run
```

Show the plan and dry-run diff to the user. Run `apply` without `--dry-run` only after explicit approval. Then run `validate`; execute the framework's real Playwright test only when the target and credentials are available and its execution is authorized.

For an existing failure, first locate the test and inspect its related source, then reproduce the failure if the environment allows it. Do not start by regenerating the whole test.
