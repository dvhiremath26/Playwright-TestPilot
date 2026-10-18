# Implementation Status

Status reflects checked-in source and local verification, not intended future behavior.

## Completed

| Area | Status | Evidence |
|---|---|---|
| Strict TypeScript workspace and shared contracts | Complete | `npm run typecheck` |
| Text, Markdown, Jira-style, and Excel normalization | Complete | Adapter tests |
| Framework scanner, symbol index, reuse and duplicate analysis | Complete | Integration and unit tests |
| CLI plan, generate, apply, validate, report, and config commands | Complete | CLI implementation and suite |
| Deterministic framework-standard proposal emission | Complete | Conformance and plan-emission tests |
| Safe path containment, diff preview, and apply | Complete | Apply/validate tests |
| VS Code extension package, commands, settings, Copilot proposal generation | Implemented; live host check pending | VSIX 0.1.5 packaged; source review |
| Browser CLI/MCP adapters and session orchestration | Implemented; live browser check pending | Browser orchestrator tests; CLI MCP configuration |
| Run-level browser observations | Extension and CLI flows wired; live target check pending | URL inference/settings, CLI snapshot, reviewer locator mapping |
| Binary Excel workbook ingestion | Complete; selects worksheet and ambiguous column mappings | ExcelJS adapter and CLI/VS Code selection |
| Saved task continuation | Implemented with source and Git HEAD/branch drift refusal | CLI `resume`; pre-generate/pre-apply checks |
| Validation recovery | Implemented with two bounded evidence-based repair proposals and revalidation | `repair`, diff review, explicit apply, validate |
| VS Code UX | Chat-style input, stage progress, task history, clear history, index rebuild | Extension commands and side panel |
| Project check | Last full run passed before current generation edits | `npm run check`: 154 tests in the prior recorded run; current typecheck passes |

## Pending

1. Verify GitHub Copilot requests from a running VS Code extension host.
2. Configure and verify Playwright MCP fallback in the extension; run browser inspection against a reachable target with a supported authentication state.
3. Complete a real end-to-end task through plan review, browser mapping, proposal review, apply, and target
   framework validation.
4. Decide whether the standalone conformance checker should be integrated into CLI/extension validation.
5. Measure reuse thresholds and repository discovery against a representative set of cases
   and frameworks.

## Intentionally not claimed as implemented

- TestPilot does not call official Playwright Planner, Generator, or Healer agents. The
  extension uses the selected Copilot model for proposals; the CLI uses the deterministic emitter.
- The CLI does not have a separate persisted proposal-approval state. Running `apply` is
  its explicit write action; the VS Code flow adds a modal confirmation.
- A passing test suite does not prove live Copilot, browser authentication, or application
  behavior. Those require host and target-environment verification.
