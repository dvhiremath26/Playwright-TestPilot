/**
 * System and user prompt templates for TCOE TestPilot's plan-first generation.
 *
 * These templates enforce the PROMPT.md rules:
 * - Keep planning and code generation as separate provider calls.
 * - Only use framework method names from the supplied actionMethods list.
 * - Surface reuse candidates before proposing new code.
 * - Keep proposed file changes bounded to the discovered framework.
 * - Never invent or assume framework methods that are not in the facts.
 */

import type { ChatMessage, PlanEntry } from '@tcoe/shared-types'
import type { TestCase } from '@tcoe/shared-types'

// ───  ────────────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return `You are a test generation assistant operating in **plan-first mode**.

## Core rule
**This is the planning call: return a structured plan only. Do not emit code, file content, or a diff.**
The TestPilot orchestrator decides whether to continue to a separate code-generation call; do not request user approval here.

## Context
You have access to the following data about the target Playwright TypeScript framework:

- \`{identity}\` — package name and description
- \`{conventions}\` — confirmed framework conventions (e.g. page-object naming, data loading, fixture usage)
- \`{actionMethods}\` — reusable action methods discovered in the framework, with file, line, and signatures
- \`{pageObjects}\` — page-object class names
- \`{locators}\` — locator field names and expressions
- \`{fixtures}\` — custom fixture names and files
- \`{testData}\` — available test-data modules
- \`{duplicateFindings}\` — any existing tests that overlap with the incoming manual test case
- \`{reuseCoverage}\` — per-step reuse analysis mapping each manual step to candidate framework methods

## Plan format
When the orchestrator requests a plan, return a structured plan. Do NOT write any test file content. The plan must contain:

1. **Test case title** (from the manual input)
2. **Decision** (reuse-existing | update-existing | create-new | needs-clarification)
3. **Step-by-step plan** — one entry per manual step:
   - The step's action text (verbatim, no rewriting)
   - The framework method or new locator it maps to (from the reuse analysis — do not invent names)
   - The target file (repository-relative path)
   - A one-line justification citing the matching action method name
4. **Proposed file changes** (kind: create | modify | delete) — file paths only at this stage
5. **Reuse evidence** — for each step that maps to an existing method, cite method name + file:line
6. **Unresolved steps** — any step with no plausible match in actionMethods, clearly marked as needing a new method

## Reuse rules
- A step maps to an existing method ONLY when the method name or parameter shape strongly implies the step's action.
- Do NOT map a step to a method named only "click" when the step says "fill in the username". Prefer methods whose names match the step's intent.
- When multiple methods could apply, rank by specificity and list the top two candidates.
- Never claim a method covers a step when you only matched on a generic word.

## Generation rules (apply only in the separate code-generation call)
- Generate one spec file per test case.
- Use the page-object class names exactly as discovered (no renaming).
- Use the locator field names exactly as discovered.
- Use existing action facade methods by their exact names (e.g. \`actions.validation.expectVisible(...)\`).
- When creating a new locator, use \`getByRole\` or \`getByLabel\` before falling back to CSS/XPath.
- Do NOT write assertions that verify more than the step's expected result.
- Include the \`@step(...)  \` logging wrapper around each action when the framework uses it.

## Recovery
When validation fails:
1. Read the actual test file on disk.
2. Compare the generated code against the failure output.
3. Propose the smallest possible fix (the minimal diff).
4. Cite the specific file and line causing the failure.

## Constraints
- Do not use method names not present in the supplied \`actionMethods\` list.
- Do not rewrite or paraphrase the manual step's action text.
- Do not fabricate evidence. If a method does not exist, say so.
- All file paths in output must use forward slashes (/) and be repository-relative.`
}

// ─── User prompt helpers ──────────────────────────────────────────────────────

export interface PlanRequestContext {
  testCaseTitle: string
  testCaseSteps: string
  reuseCoverage: string
  duplicateFindings: string
  conventions: string
  actionMethodsSummary: string
  pageObjectNames: string[]
  locatorExamples: string[]
  fixtures: string[]
  testDataModules: string[]
  /** Multiple titled cases supplied in one manual input, when present. */
  manualTestCases?: TestCase[]
  taskId: string
  approvalMode: 'manual' | 'auto'
  /**
   * The step plan the deterministic analyzer already produced. Passed through
   * so a provider that does not reason — the mock — can report what was actually
   * discovered instead of guessing at method names and paths. Omitted by the
   * generation prompt, which carries the approved plan as text instead.
   */
  plan?: PlanEntry[]
}

export function buildPlanUserPrompt(ctx: PlanRequestContext): string {
  return `## Manual test case

**Title:** ${ctx.testCaseTitle}

**Steps:**
${ctx.testCaseSteps}

${ctx.manualTestCases && ctx.manualTestCases.length > 1 ? `## Additional titled test cases in this request

${ctx.manualTestCases.slice(1).map((testCase, index) => `### Case ${index + 2}: ${testCase.title}\n${testCase.steps.map((step) => `${step.order}. ${step.action}${step.expectedResult ? ` — expected: ${step.expectedResult}` : ''}`).join('\n')}`).join('\n\n')}

Treat these as separate expected test outcomes and data rows. Identify which actions and screens are common so locator evidence can be reused accurately.
` : ''}

---

## Framework reuse analysis

${ctx.reuseCoverage}

---

## Existing duplicate tests

${ctx.duplicateFindings}

---

## Framework conventions

${ctx.conventions}

---

## Available action methods

${ctx.actionMethodsSummary}

---

## Available page objects
${ctx.pageObjectNames.map((p) => `- ${p}`).join('\n')}

## Available locators (examples)
${ctx.locatorExamples.map((l) => `- ${l}`).join('\n')}

## Available fixtures
${ctx.fixtures.map((f) => `- ${f}`).join('\n')}

## Available test-data modules
${ctx.testDataModules.map((m) => `- ${m}`).join('\n')}

---

## Step plan already computed
Use these mappings verbatim. Do not invent any method or path that is not listed here.

${(ctx.plan ?? []).map((e) => {
  const cite = e.facadePath ?? e.targetSymbol ?? '(no symbol matched)'
  const file = e.targetFile ?? '(no file)'
  const lines = [
    `- step ${e.stepOrder} | ${e.resolution} | ${e.stepAction}`,
    `    facade=${cite}`,
    `    file=${file}`,
  ]
  if (e.unresolvedReason) lines.push(`    unresolved: ${e.unresolvedReason}`)
  return lines.join('\n')
}).join('\n')}

---

Task ID: ${ctx.taskId}
Approval mode: ${ctx.approvalMode}

## Your task
Return the structured plan above only. Do not generate files in this planning stage. TestPilot will decide whether to continue to code generation.`
}

// ─── Generation user prompt ──────────────────────────────────────────────────

export interface GenerationContext extends PlanRequestContext {
  approvedPlan: string
  targetSpecPath: string
  targetPagePath?: string
  targetLocatorPath?: string
  targetDataPath?: string
  browserEvidence?: string
  /** Real, indexed source excerpts from the target framework. */
  frameworkExamples?: string
  /** Deterministically extracted, non-secret data values keyed by this case. */
  manualTestData?: {
    moduleName: string
    cases: Array<{ caseKey: string; title: string; values: Record<string, string> }>
    sharedFlow?: boolean
    targetPath: string
    existingJson?: string
    dataTypesPath?: string
  }
}

export function buildGenerationUserPrompt(ctx: GenerationContext): string {
  const planWord = ctx.approvalMode === 'auto' ? 'selected' : 'approved'
  const planHeader = ctx.approvalMode === 'auto'
    ? '## Plan selected by TestPilot\n\nUse this plan to generate the requested files:'
    : '## Plan approved\n\nThe following plan was approved:'
  return `${planHeader}

${ctx.approvedPlan}

${ctx.manualTestCases && ctx.manualTestCases.length > 1 ? `## All titled cases in this request

${ctx.manualTestCases.map((testCase, index) => `### Case ${index + 1}: ${testCase.title}\n${testCase.steps.map((step) => `${step.order}. ${step.action}${step.expectedResult ? ` — expected: ${step.expectedResult}` : ''}`).join('\n')}`).join('\n\n')}

Preserve each case and its expected outcome. Decide whether to make one data-driven spec or multiple specs from the actual flow overlap; share page and locator classes when the screens/actions match.
` : ''}

---

Target files:
- Spec: ${ctx.targetSpecPath}
- Page object: ${ctx.targetPagePath ?? '(derive from the test case title and framework conventions)'}
- Locators: ${ctx.targetLocatorPath ?? '(derive from the page object and framework conventions)'}
- Test data: ${ctx.targetDataPath ?? '(only when non-secret test data is required)'}

${ctx.manualTestData ? `## Manual test data (required)

The following non-secret input values were extracted from the manual steps. Do not hardcode these values in the spec or page object. Use the framework's DataLoader and pass these values to the page methods/assertions:
- Module: ${ctx.manualTestData.moduleName}
- Case rows: ${JSON.stringify(ctx.manualTestData.cases)}
- Ordered-flow comparison: ${ctx.manualTestData.sharedFlow ? 'these cases appear to share an ordered flow after masking inline data' : 'these cases have different ordered flows; keep their behavior distinct'}
- Data file: ${ctx.manualTestData.targetPath}
- Data access shape: DataLoader.get('${ctx.manualTestData.moduleName}')['<caseKey>'].<key>. Each JSON case row is already the values object; do not add a .values wrapper.
${ctx.manualTestData.existingJson ? `- Existing contents to preserve and extend: ${ctx.manualTestData.existingJson}` : '- No data file exists yet; create it with this case key and values.'}
${ctx.manualTestData.dataTypesPath ? `- Register the module in ${ctx.manualTestData.dataTypesPath} using the framework's existing DataRegistry convention.` : ''}
Choose the implementation shape from the cases: when they share the same actions/screens and differ only by data, prefer one data-driven spec with one test per case and shared page/locator files; when their flows or expected outcomes materially differ, use separate tests/specs while still sharing compatible page/locator assets. Keep the scenario's page and locator paths shared across cases, and preserve every distinct case title and expected result.
` : ''}

${ctx.browserEvidence ? `## Browser observations and locator candidates\n\n${ctx.browserEvidence}\n\nUse an observed locator only when its step and page context match the manual action. The Playwright CLI snapshot is the primary browser evidence; do not claim a locator was observed if it is absent here.\n` : 'No live browser observations were captured. Reuse indexed framework locators when they match; otherwise leave the specific step clearly marked as unresolved instead of inventing a selector.\n'}

For assertions against text that changes between test-data rows, use the assertion step's own snapshot candidate whose observed name matches the expected displayed value. Do not reuse the input textbox or a section heading. If the snapshot provides an observed getByText candidate, define a locator-class method that accepts the expected text and returns this.page.getByText(expectedText). Use the same getByText strategy observed in the assertion snapshot, with the expected value supplied from DataLoader; do not hardcode a case value or invent a CSS selector. Keep the locator method inside the framework's locator class and have the page object use it.

${ctx.frameworkExamples ? `## Authoritative framework source examples\n\nThese are real files from the target repository. Match their architecture, imports, naming, formatting, and APIs. They take precedence over generic Playwright habits.\n\n${ctx.frameworkExamples}\n` : ''}

Generate complete, executable files that conform to the target framework; framework conformance is mandatory, not a style preference. Include every manual step in order. Reuse existing action methods, fixtures, page objects, and locators listed in the context. When a step has no existing method, create a method on a page class that follows the real page-object example, with a locator field in the paired locator class. Locator fields must be Playwright Locator expressions (for example this.page.getByRole(...)), never strings that merely contain locator code such as 'getByRole(...)'; do not pass role/label/text expressions as CSS selectors to page.locator(). The spec must use the framework's configured custom fixture and import conventions shown in the examples, and must not use test.only, describe.only, it.only, fit, or fdescribe. Ignore Xray: do not add Xray imports, IDs, annotations, or integrations, even if an example file contains them. Page classes and locator classes must follow the observed base-class, constructor, naming, and action-wrapper patterns. Follow confirmed conventions and the ${planWord} plan. Do not invent framework APIs or selectors. If any behavior cannot be implemented from supplied evidence, include an explicit TODO for that specific step and explain the missing evidence. Output fenced TypeScript blocks with repository-relative paths and always include a tests/*.spec.ts file.`
}
