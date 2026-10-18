/**
 * Human-readable report rendering for the CLI.
 *
 * Every section states what was concluded and what remains uncertain. When the
 * run used the offline mock provider, the report says so prominently so the
 * output is never mistaken for a real model's plan.
 */

import type { PlanEntry, TaskRecord } from '@tcoe/shared-types'

export function renderReport(
  task: TaskRecord,
  planText: string | undefined,
  usedMockProvider: boolean,
): string {
  const lines: string[] = []
  const rule = '='.repeat(78)

  lines.push(rule)
  lines.push(`TCOE TestPilot — Task ${task.taskId}`)
  lines.push(`Status: ${task.status}`)
  lines.push(`Title:  ${task.title}`)
  lines.push(`Source: ${task.testCaseSource}`)
  lines.push(`Repo:   ${task.repositoryRoot}`)
  lines.push(rule)

  // --- Stages
  lines.push('')
  lines.push('STAGES')
  for (const stage of task.stages) {
    const mark =
      stage.status === 'completed' ? '[x]' :
      stage.status === 'in-progress' ? '[~]' :
      stage.status === 'failed' ? '[!]' : '[-]'
    lines.push(`  ${mark} ${stage.stage.padEnd(12)} ${stage.summary ?? ''}`)
  }

  // --- Decision
  if (task.decision) {
    lines.push('')
    lines.push('DECISION')
    lines.push(`  ${task.decision.decision}`)
    lines.push(`  Rationale: ${task.decision.rationale}`)
    for (const e of task.decision.evidence) lines.push(`    - ${e}`)
  }

  // --- Duplicates
  if (task.reuseReport && task.reuseReport.duplicates.length > 0) {
    lines.push('')
    lines.push('DUPLICATE CANDIDATES')
    for (const d of task.reuseReport.duplicates) {
      lines.push(`  ${d.verdict} (${d.similarity}) — ${d.existingTest.title}`)
      lines.push(`    ${d.existingTest.file}:${d.existingTest.line}`)
      for (const e of d.evidence) lines.push(`    evidence: ${e}`)
      lines.push(`    → ${d.recommendation}`)
    }
  }

  // --- Plan
  if (task.plan && task.plan.length > 0) {
    lines.push('')
    lines.push('STEP PLAN')
    for (const entry of task.plan) {
      lines.push(renderPlanEntry(entry))
    }
  }

  // --- Reuse confidence
  if (task.reuseReport) {
    lines.push('')
    lines.push('REUSE CONFIDENCE')
    lines.push(`  score: ${task.reuseReport.confidence.score}`)
    for (const r of task.reuseReport.confidence.reasons) lines.push(`    - ${r}`)
  }

  // --- Missing functionality
  if (task.reuseReport && task.reuseReport.missingFunctionality.length > 0) {
    lines.push('')
    lines.push('MISSING FRAMEWORK FUNCTIONALITY')
    for (const m of task.reuseReport.missingFunctionality) lines.push(`  ! ${m}`)
  }

  // --- Validation
  if (task.validation) {
    lines.push('')
    lines.push(`VALIDATION — ${task.validation.passed ? 'PASSED' : 'FAILED'}`)
    for (const check of task.validation.checks) {
      const mark = check.skipped ? 'SKIP' : check.passed ? 'PASS' : 'FAIL'
      lines.push(`  [${mark}] ${check.description}`)
      if (!check.passed || check.skipped) {
        lines.push(`         ${check.detail.split('\n').join('\n         ')}`)
      }
    }
  }

  // --- Plan narrative
  if (planText) {
    lines.push('')
    lines.push('PROVIDER PLAN')
    lines.push('─'.repeat(78))
    for (const line of planText.split('\n')) lines.push(line)
    lines.push('─'.repeat(78))
  }

  // --- Provenance / uncertainty
  lines.push('')
  lines.push('PROVENANCE')
  for (const call of task.modelCalls) {
    lines.push(`  ${call.at} — ${call.provider}/${call.model ?? 'unknown'} (${call.purpose})`)
  }
  if (task.modelCalls.length === 0) {
    lines.push('  no model calls were made')
  }
  if (usedMockProvider) {
    lines.push('')
    lines.push('  WARNING: the mock provider was used. This plan was generated offline by')
    lines.push('  deterministic rules, not by a model. Treat it as a structural preview only.')
  }

  if (task.error) {
    lines.push('')
    lines.push(`ERROR (${task.error.stage}): ${task.error.message}`)
  }

  return lines.join('\n')
}

function renderPlanEntry(entry: PlanEntry): string {
  const lines: string[] = []
  lines.push(`  Step ${entry.stepOrder}: ${entry.stepAction}`)
  if (entry.stepExpected) lines.push(`    expected: ${entry.stepExpected}`)
  lines.push(`    resolution: ${entry.resolution}`)
  if (entry.facadePath) lines.push(`    facade:    ${entry.facadePath}`)
  if (entry.targetSymbol) lines.push(`    symbol:    ${entry.targetSymbol}`)
  if (entry.targetFile) lines.push(`    file:      ${entry.targetFile}`)
  if (entry.verifiedLocator) {
    lines.push(`    browser locator: ${entry.verifiedLocator.expression}`)
    lines.push(`    observed ref:    ${entry.verifiedLocator.ref} (${entry.verifiedLocator.backend})`)
    if (entry.verifiedLocator.pageUrl) lines.push(`    observed page:   ${entry.verifiedLocator.pageUrl}`)
  }
  for (const e of entry.evidence) lines.push(`    evidence:  ${e}`)
  if (entry.unresolvedReason) lines.push(`    UNRESOLVED: ${entry.unresolvedReason}`)
  return lines.join('\n')
}
