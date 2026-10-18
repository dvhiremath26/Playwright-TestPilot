# Roadmap

## Completed and verified locally

- Core input adapters, framework scanning/indexing, reuse analysis, planning, safe change
  application, and validation.
- CLI workflow for `plan` → `generate` → `apply` → `validate`.
- VS Code extension model selection and plan/proposal flow, including reviewable diffs,
  modal apply confirmation, and selected-model code generation. Version 0.1.5 has been packaged.
- Browser-tool adapters, session orchestration, factory, and opt-in page-snapshot capture.
- Binary `.xlsx` file reading, worksheet selection, and explicit ambiguous-column mapping in VS Code and CLI.
- Playwright CLI locator generation from observed refs, with reviewer-selected step mapping; unsupported MCP locator generation remains explicit.
- Bounded (two attempts) evidence-based repair proposals, approval before apply, and re-validation.
- VS Code chat-style input, stage progress, task history, clear-history, and rebuild-index actions.
- Saved-plan resume command with source-file and Git HEAD/branch drift checks before generation or apply.
- Repository-specific test update skill at `.github/skills/update-playwright-test/SKILL.md`.
- `npm run check`: TypeScript check and all 154 tests.

## Next: complete integrations

1. Exercise `vscode.lm` in a real VS Code extension host with an available Copilot model.
2. Run the extension browser flow against a reachable application and confirm how
  authentication state is provided without storing credentials in TestPilot. Configure
  extension-side MCP fallback; the current extension uses Playwright CLI only.
3. Run a full representative task through plan, browser review, proposal review, apply, repair (if needed), and validation.
4. Evaluate reuse scoring on a larger set of manual cases and investigate discovery
   completeness for the target framework.
5. Decide whether the standalone `npm run check:conformance` checker should be part of
   the normal validation flow.

## Deferred

- Live Jira connection; current Jira support parses pasted/exported issue content.
- Electron UI.
- Integration with official Playwright Planner/Generator/Healer agents. The extension
  currently uses the selected Copilot model for proposals; the CLI uses TestPilot's
  deterministic framework emitter.

## Out of scope

- TestPilot does not perform Git commits, pushes, resets, or stashes.
- TestPilot does not hold SAP credentials or embed them in target URLs.
