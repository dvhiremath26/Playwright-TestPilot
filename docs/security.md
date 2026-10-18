# Security Design

The agent reads a lot of a company's test code and writes into a framework other engineers
maintain. The threat model here is accidental damage and credential leakage, not a hostile attacker.

## Secrets

### Storage

API keys are resolved from environment variables only. The config object never holds a literal key.

In `tcoe-testpilot.config.json` the key is named, not written:

```json
{ "provider": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "apiKey": "env:OPENAI_API_KEY" }
```

`loadFromFile` converts `apiKey` to `apiKeyEnvVar` **only** when the value starts with `env:`.
Any other value is dropped. A literal key pasted into the config file is therefore never loaded,
which means it cannot reach a log, an error message, or a report by accident.

There are no credentials for the SAP S/4HANA target system anywhere in this codebase, and the
agent never requests or reads any.

### Redaction

`packages/provider-abstraction/src/redaction.ts` scrubs three shapes:

1. URL userinfo — `https://user:pass@host` becomes `https://***@host`.
2. Long tokens — any run of 32+ base64-like characters becomes `[REDACTED]`.
3. Known secret field names — `apiKey`, `token`, `password`, `clientSecret`, and so on, recursed
   through objects with cycle protection.

`safeConfigDump()` runs the whole config through it before printing. `config --show` is safe to
share.

**What this does not do:** it is a best-effort text scrub, not a complete secret detector. Tokens
shorter than 32 characters pass through untouched. Field-name matching only applies to objects
passed to `redactObject()`, not to arbitrary strings. Anything that must never appear in logs
should never be constructed, not merely redacted on the way out.

## Path containment

The agent modifies exactly one repository and nothing else.

- `apply.ts` refuses any proposed path that resolves outside the repository root.
- A resolved target must be a file path, not a directory. This was a real defect: the ancestor
  check returned the parent directory as the "resolved" path, so creating a new file under an
  existing directory would have looked like overwriting that directory.
- Proposed paths are validated to the same containment rule before any write.
- Task state is written only under the configured state directory. `plan --read-only` writes
  nothing to the framework repository at all.

## Destructive operations

Writes are gated and reversible:

- **Nothing is written before plan approval.** The runner stops at `AwaitingApproval` and the
  `generate` command refuses to run for an unapproved task.
- **Overwriting requires a recorded prior state.** `apply.ts` refuses to replace file content
  unless a snapshot of the original content was recorded. Writing without one is logged as a
  failure rather than silently dropping the previous version.
- **Every write is preceded by a unified diff and a checkpoint.** Checkpoints let a run be
  rolled back without touching git.
- **Existing files are inspected before overwrite.** The apply path reads current content and
  refuses blind replacement.
- **Nothing is force-overwritten.** No force flags, no `--hard` equivalents.

## Git operations

**The agent performs no Git operations whatsoever.** No commits, pushes, resets, stashes, or
branch changes. It writes files to the working tree and leaves version control entirely to a human.

Nothing in this project should be committed, pushed, or reset by the agent — including its own
changes. That requires explicit authorization, and the user has withheld it.

## Running repository code

The validation step executes `npm run typecheck`, `npm run lint`, and optionally `npm run test`
**inside the target repository**. That runs whatever those scripts run. The scripts are the target
team's, but this is worth stating plainly: validation is not sandboxed. Do not point the agent at a
repository you would not otherwise run npm scripts in.

There is no allowlist restricting which repositories the tool may be pointed at. The `--repo`
argument is trusted.

## No telemetry

The agent makes exactly one outbound call: to the configured model endpoint. Nothing else leaves
the machine — no analytics, no crash reporting, no usage collection. Task records, indexes,
checkpoints, and reports are all local files.

## The approval gate is a control, not a convenience

Manual approval mode is the default. Beyond the PROMPT.md requirement, it exists because the
generated code lands in a maintained framework and the value of this tool is a reviewed plan with
cited evidence, not unattended code. `auto` mode exists for CI where the plan was already reviewed
out of band, and it is not the default.
