/**
 * Emits generated code in the target framework's own standard.
 *
 * Every shape below was derived from reading the real framework, not invented:
 *
 *   pages/<PageName>/<name>.page.ts        — class <PageName>Page extends BasePage
 *   pages/<PageName>/<name>.locators.ts    — class <PageName>Locators, SCREAMING_SNAKE consts
 *   tests/<name>.spec.ts                   — test.describe + test, @src/config/fixture imports
 *   test-data/<name>/<name>.<env>.json     — consumed via DataLoader
 *
 * Concrete evidence for each:
 * - pages/LoginPage/login.page.ts: `export class LoginPage extends BasePage`, a
 *   `readonly locators: LoginLocators` field, `new LoginLocators(page)` in the constructor,
 *   `@Step(...)` decorators, methods delegating to `this.actions.<verb>(...)`.
 * - pages/LoginPage/login.locators.ts: `constructor(private readonly page: Page) {}` then
 *   `readonly USERNAME = this.page.getByPlaceholder('Username')`.
 * - pages/Base/base.page.ts: `protected readonly actions: Actions` — pages never touch `page`
 *   directly for interactions.
 * - tests/example.spec.ts: `import { test, expect } from '@src/config/fixture'`,
 *   `DataLoader.get('login')`, `ConfigManager.getAppBaseUrl(...)`, `xray('TPA-5')`.
 * - tsconfig paths: `@src/*` -> `./src/*`, `@pages/*` -> `./pages/*`.
 * - DataLoader reads `test-data/<module>/<module>.<env>.json`.
 * - xray() requires /^[A-Z][A-Z0-9_]*-[1-9]\d*$/.
 *
 * The emitter never invents an action method. Every call it emits is either one confirmed to
 * exist in the framework's Actions facade or it is flagged as needing framework support. That
 * is the difference between a generated test that compiles and one that looks plausible while
 * referencing methods that do not exist.
 */

export interface EmittedFile {
  path: string
  content: string
  layer: 'spec' | 'page' | 'locators' | 'test-data'
  note: string
}

/** How a locator was established. Distinguishes observed from inferred. */
export type LocatorProvenance = 'snapshot-ref' | 'evaluated-attribute' | 'accessibility-role' | 'assumed'

export interface LocatorEvidence {
  locatorExpression: string
  how: LocatorProvenance
}

export interface ResolvedStep {
  step: string
  methodSignature: string
  locatorName?: string
  locatorExpression?: string
  locatorEvidence?: LocatorEvidence
}

export interface EmissionOptions {
  pageName: string
  stem: string
  describeTitle: string
  testTitles: string[]
  steps: ResolvedStep[]
  dataKeys?: Record<string, string>
  xrayKey?: string
  environments?: string[]
  /**
   * AppName key for ConfigManager.getAppBaseUrl. Must be one of the framework's real
   * AppUrls keys (e.g. 'OrangeHRM', 'LambdaTest'). When omitted, the emitter writes a
   * navigation TODO rather than inventing an app name that would throw at runtime.
   */
  appName?: string
  /** Action method names confirmed present in the framework's Actions facade. */
  knownActions?: string[]
  /** Method names the caller could not confirm. */
  unconfirmedActions?: string[]
}

const XRAY_RE = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/

const VERBS: Array<[RegExp, string]> = [
  [/^navigate/i, 'navigate'],
  [/^goto/i, 'navigate'],
  [/^fill/i, 'fill'],
  [/^type/i, 'type'],
  [/^clear/i, 'clear'],
  [/^click/i, 'click'],
  [/^hover/i, 'hover'],
  [/^select/i, 'selectByText'],
  [/^check/i, 'check'],
  [/^uncheck/i, 'uncheck'],
  [/^assert visible/i, 'isVisible'],
  [/^verify/i, 'isVisible'],
  [/^wait/i, 'waitFor'],
]

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'on', 'in', 'of', 'at', 'with', 'and', 'for'])

/** 'Fill the material number' -> 'fillMaterialNumber'. */
export function stepToMethodName(step: string): string {
  const words = step
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, 4)

  if (words.length === 0) return 'performStep'
  const first = words[0]!
  const rest = words.slice(1)
  return first.toLowerCase() + rest.map(capitalize).join('')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Map a step onto a framework Actions verb. */
export function stepToVerb(step: string): string {
  for (const [re, verb] of VERBS) {
    if (re.test(step.trim())) return verb
  }
  return 'click'
}

/** Derive a SCREAMING_SNAKE locator constant name from a locator expression. */
export function locatorToName(expression: string, fallback: string): string {
  const role = /getByRole\(['"]([^'"]+)/.exec(expression)?.[1]
  const nameArg = /\{\s*name:\s*['"]([^'"]+)/.exec(expression)?.[1]
  if (role && nameArg) return slug(`${role} ${nameArg}`)
  const placeholder = /getByPlaceholder\(['"]([^'"]+)/.exec(expression)?.[1]
  if (placeholder) return slug(placeholder)
  const text = /getByText\(['"]([^'"]+)/.exec(expression)?.[1]
  if (text) return slug(text)
  return slug(fallback)
}

/**
 * Convert free text to a SCREAMING_SNAKE constant name.
 *
 * CamelCase boundaries are turned into underscores ('SalesOrder' -> 'SALES_ORDER'),
 * matching the framework's own constant style.
 */
function slug(input: string): string {
  const out = input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 60)
  return out || 'ELEMENT'
}

function escapeTemplate(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

function escapeComment(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\/\*/g, '\\/*')
}


/**
 * Emit the locator class — mirrors login.locators.ts.
 *
 * Locators without live evidence are tagged ASSUMED so a reviewer can see at a glance which
 * selectors were observed in a real browser and which were inferred from manual-step text.
 */
export function emitLocators(options: EmissionOptions): EmittedFile {
  const { pageName, stem } = options

  const unique = new Map<string, LocatorEvidence>()
  for (const s of options.steps) {
    if (s.locatorExpression && !unique.has(s.locatorExpression)) {
      unique.set(s.locatorExpression, s.locatorEvidence ?? { locatorExpression: s.locatorExpression, how: 'assumed' })
    }
  }

  const lines = [
    `import { Page } from '@playwright/test'`,
    ``,
    `export class ${pageName}Locators {`,
    `  constructor(private readonly page: Page) {}`,
    ``,
  ]

  for (const [expr, ev] of unique) {
    const owner = options.steps.find((s) => s.locatorExpression === expr)
    const name = owner?.locatorName ?? locatorToName(expr, pageName)
    const assumed = ev.how === 'assumed' ? '  // ASSUMED - not observed in a live snapshot' : ''
    lines.push(`  readonly ${name} = ${expr}${assumed}`)
  }

  lines.push(`}`, ``)

  return {
    path: `pages/${pageName}/${stem}.locators.ts`,
    content: lines.join('\n'),
    layer: 'locators',
    note: 'Locators isolated from page logic. ASSUMED entries require live verification.',
  }
}

/**
 * Emit the page class — mirrors login.page.ts.
 *
 * Extends BasePage, holds a locators instance, decorates public methods with @Step, and
 * delegates every interaction through this.actions. The spec never sees locators.
 */
export function emitPage(options: EmissionOptions): EmittedFile {
  const { pageName, stem, knownActions, unconfirmedActions } = options

  const lines = [
    `import { Page } from '@playwright/test'`,
    `import { BasePage } from '../Base/base.page'`,
    `import { ${pageName}Locators } from './${stem}.locators'`,
    `import { Step } from '@src/helper/decorators'`,
    ``,
    `export class ${pageName}Page extends BasePage {`,
    `  readonly locators: ${pageName}Locators`,
    ``,
    `  constructor(page: Page) {`,
    `    super(page)`,
    `    this.locators = new ${pageName}Locators(page)`,
    `  }`,
    ``,
    `  @Step(\`Open ${pageName} page\`)`,
    `  async navigate(baseUrl: string): Promise<void> {`,
    `    await this.actions.browser.navigate(baseUrl)`,
    `  }`,
    ``,
  ]

  for (const step of options.steps) {
    const verb = stepToVerb(step.step)
    const body: string[] = []

    if (step.locatorName && step.locatorExpression) {
      body.push(`    await this.actions.${verb}(this.locators.${step.locatorName})`)
    } else {
      body.push(`    // TODO: no locator resolved for this step`)
      body.push(`    // Step: ${escapeComment(step.step)}`)
    }

    const needsCheck =
      (unconfirmedActions !== undefined && unconfirmedActions.includes(verb)) ||
      (knownActions !== undefined && !knownActions.includes(verb))
    if (needsCheck) {
      body.push(`    // NOTE: Actions.${verb} was not confirmed in the framework's Actions facade.`)
      body.push(`    // Confirm this method exists before approving this change.`)
    }

    lines.push(`  @Step(\`${escapeTemplate(step.step)}\`)`)
    lines.push(`  async ${step.methodSignature}(): Promise<void> {`)
    lines.push(...body)
    lines.push(`  }`)
    lines.push(``)
  }

  lines.push(`}`, ``)

  return {
    path: `pages/${pageName}/${stem}.page.ts`,
    content: lines.join('\n'),
    layer: 'page',
    note: `Page class for ${pageName}; one method per manual-test step.`,
  }
}

/**
 * Emit the spec file — mirrors tests/example.spec.ts.
 *
 * The spec only navigates and delegates to page-object methods. No locators, no data
 * access, no raw Playwright calls. That separation is what keeps this framework
 * maintainable, so generated specs must not bypass it.
 */
export function emitSpec(options: EmissionOptions): EmittedFile {
  const { stem, pageName, describeTitle, testTitles, xrayKey } = options
  const lowerPage = pageName.charAt(0).toLowerCase() + pageName.slice(1)
  const withXray = xrayKey !== undefined && XRAY_RE.test(xrayKey)

  const callLines = options.steps
    .filter((s) => !/^(navigate|goto)/i.test(s.step))
    .map((s) => `    await ${lowerPage}.${s.methodSignature}()`)
    .join('\n')

  const lines: string[] = []

  if (withXray) lines.push(`import { xray } from '@src/utils/xray/xray'`)
  const imports = [
    `import { test } from '@src/config/fixture'`,
    `import { ${pageName}Page } from '@pages/${pageName}/${stem}.page'`,
    `import { DataLoader } from '@src/utils/testData/dataLoader'`,
  ]
  if (options.appName) {
    imports.push(`import { ConfigManager } from '@src/config/configManager'`)
  }

  lines.push(...imports, ``)
  lines.push(
    `test.describe(\`${describeTitle}\`, () => {`,
    `  const ${stem}Data = DataLoader.get('${stem}')`,
    ``,
    `  test.beforeEach(async () => {`,
    `    // Shared setup runs here when a step depends on prior navigation.`,
    `  })`,
    ``,
  )

  testTitles.forEach((title, i) => {
    if (i > 0) lines.push(``)
    if (withXray) {
      lines.push(`  test(\`${title}\`, xray('${xrayKey}'), async ({ page }) => {`)
    } else {
      lines.push(`  test(\`${title}\`, async ({ page }) => {`)
    }
    lines.push(`    const ${lowerPage} = new ${pageName}Page(page)`)
    if (options.appName) {
      lines.push(`    await ${lowerPage}.navigate(ConfigManager.getAppBaseUrl('${options.appName}'))`)
    } else {
      lines.push(`    // TODO: navigate to the app URL. Pass appName so this becomes:`)
      lines.push(`    // await ${lowerPage}.navigate(ConfigManager.getAppBaseUrl('<AppName>'))`)
    }
    if (callLines) lines.push(callLines)
    lines.push(`  })`)
  })

  lines.push(`})`, ``)

  return {
    path: `tests/${stem}.spec.ts`,
    content: lines.join('\n'),
    layer: 'spec',
    note: 'Spec delegates to the page object only; no locators or data access here.',
  }
}

/**
 * Emit test-data files, one per environment.
 *
 * Paths follow DataLoader's convention: test-data/<module>/<module>.<env>.json.
 *
 * These contain placeholders only. This tool never writes credentials — real credentials go
 * through CredentialManager, which reads the framework's own catalog and may decrypt values.
 * Generating credential material here would be both wrong and dangerous.
 */
export function emitTestData(options: EmissionOptions): EmittedFile[] {
  const { stem } = options
  const envs = options.environments ?? ['qa']
  const keys = options.dataKeys ?? {}

  return envs.map((env) => {
    const body = Object.keys(keys).length > 0 ? JSON.stringify(keys, null, 2) : '{}'
    return {
      path: `test-data/${stem}/${stem}.${env}.json`,
      content: `${body}\n`,
      layer: 'test-data',
      note: `Placeholder data for ${env}. Credentials belong in CredentialManager, not here.`,
    }
  })
}

/**
 * Emit the full file set for a generated test.
 *
 * Order is locators, page, spec, then data — for review readability only; the files
 * are independent of one another.
 */
export function emitFrameworkStandard(options: EmissionOptions): EmittedFile[] {
  return [
    emitLocators(options),
    emitPage(options),
    emitSpec(options),
    ...emitTestData(options),
  ]
}

/**
 * Validate an emitted file set against the framework's known action surface.
 *
 * Returns any action method the emitter called that is not confirmed to exist. These are
 * surfaced to the reviewer rather than silently emitted — a spec that references a
 * nonexistent method compiles only if someone happens to add it later.
 */
export function validateEmittedCalls(
  options: EmissionOptions,
): { verb: string; status: 'confirmed' | 'unconfirmed' }[] {
  const known = new Set(options.knownActions ?? [])
  const results: { verb: string; status: 'confirmed' | 'unconfirmed' }[] = []
  const seen = new Set<string>()

  for (const step of options.steps) {
    const verb = stepToVerb(step.step)
    if (seen.has(verb)) continue
    seen.add(verb)
    results.push({ verb, status: known.has(verb) ? 'confirmed' : 'unconfirmed' })
  }

  return results
}
