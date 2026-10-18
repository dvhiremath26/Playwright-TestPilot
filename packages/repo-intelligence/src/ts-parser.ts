/**
 * Deterministic TypeScript symbol extraction.
 *
 * A hand-written scanner over the TypeScript compiler API gives real AST
 * facts: class declarations, method signatures, decorators, exported symbols.
 * Regex matching would misreport the framework, and a wrong index would make
 * the agent invent methods.
 */

import ts from 'typescript'

import type {
  ImportInfo,
  IndexedActionMethod,
  IndexedLocator,
  IndexedSymbol,
  LocatorStrategy,
  SymbolKind,
} from '@tcoe/shared-types'

export interface ParsedModule {
  /** Module-level imports. */
  imports: ImportInfo[]
  symbols: IndexedSymbol[]
  /** Action methods with facade namespaces, filled by the analyzer. */
  rawMethods: RawMethod[]
  /** Locator fields declared with `this.page.<strategy>(...)`. */
  rawLocators: RawLocator[]
  /** Decorator names used at module level. */
  decorators: string[]
  /** Exported names. */
  exports: string[]
}

export interface RawMethod {
  name: string
  ownerClass: string
  line: number
  signature: string
  parameters: { name: string; type: string }[]
  returnType?: string
  decorators: string[]
  exported: boolean
  docSummary?: string
  /** 1-based line of the owning class declaration. */
  ownerLine: number
}

export interface RawLocator {
  name: string
  ownerClass: string
  line: number
  expression: string
  strategy: LocatorStrategy
}

export function parseTypeScript(source: string, relativePath: string): ParsedModule {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )

  const imports: ImportInfo[] = []
  const symbols: IndexedSymbol[] = []
  const rawMethods: RawMethod[] = []
  const rawLocators: RawLocator[] = []
  const decorators = new Set<string>()
  const exports: string[] = []

  const { line: lineOf } = createLineIndex(source, sourceFile)

  for (const statement of sourceFile.statements) {
    collectImports(statement, imports)

    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (decl.initializer) {
          const strategy = detectLocatorStrategy(decl.initializer)
          if (strategy) {
            rawLocators.push({
              name: nameOf(decl.name),
              ownerClass: '',
              line: lineOf(decl),
              expression: decl.initializer.getText(),
              strategy,
            })
          }
        }
      }
      continue
    }

    const decoratorNames = decoratorsOf(statement)
    for (const name of decoratorNames) decorators.add(name)

    const docSummary = docSummaryOf(statement)
    const isExported = isExportKeywordPresent(statement)

    if (ts.isClassDeclaration(statement) && statement.name) {
      const className = statement.name.text
      if (isExported) exports.push(className)

      symbols.push({
        name: className,
        kind: hasAbstractModifier(statement) ? 'abstract-class' : 'class',
        file: relativePath,
        line: lineOf(statement),
        exported: isExported,
        parameters: [],
        docSummary,
      })

      collectClassMembers(statement, className, isExported, relativePath, lineOf, {
        symbols,
        rawMethods,
        rawLocators,
        exports,
      })
      continue
    }

    if (ts.isInterfaceDeclaration(statement) && statement.name) {
      if (isExported) exports.push(statement.name.text)
      symbols.push({
        name: statement.name.text,
        kind: 'interface',
        file: relativePath,
        line: lineOf(statement),
        exported: isExported,
        parameters: [],
        docSummary,
      })
      continue
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      if (isExported) exports.push(statement.name.text)
      symbols.push({
        name: statement.name.text,
        kind: 'type',
        file: relativePath,
        line: lineOf(statement),
        exported: isExported,
        parameters: [],
        docSummary,
      })
      continue
    }

    if (ts.isEnumDeclaration(statement)) {
      if (isExported) exports.push(statement.name.text)
      symbols.push({
        name: statement.name.text,
        kind: 'enum',
        file: relativePath,
        line: lineOf(statement),
        exported: isExported,
        parameters: [],
        docSummary,
      })
      continue
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (isExported) exports.push(statement.name.text)
      symbols.push({
        name: statement.name.text,
        kind: 'function',
        file: relativePath,
        line: lineOf(statement),
        exported: isExported,
        parameters: parametersOf(statement.parameters),
        returnType: typeText(statement.type),
        docSummary,
      })
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const isArrow = decl.initializer && ts.isArrowFunction(decl.initializer)
        const kind: SymbolKind = isArrow ? 'function' : 'const'
        if (isExported) exports.push(nameOf(decl.name))
        symbols.push({
          name: nameOf(decl.name),
          kind,
          file: relativePath,
          line: lineOf(decl),
          exported: isExported,
          parameters: isArrow ? parametersOf(decl.initializer.parameters) : [],
          returnType: isArrow ? typeText(decl.initializer.type) : undefined,
          docSummary,
        })
      }
    }
  }

  return {
    imports,
    symbols,
    rawMethods,
    rawLocators,
    decorators: [...decorators].sort(),
    exports: exports.sort(),
  }
}

function collectImports(statement: ts.Statement, imports: ImportInfo[]): void {
  if (ts.isImportDeclaration(statement) && statement.importClause) {
    const specifier = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : ''
    if (!specifier) return

    const localNames: string[] = []
    const clause = statement.importClause

    if (clause.name) localNames.push(clause.name.text)
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        localNames.push(clause.namedBindings.name.text)
      } else {
        for (const element of clause.namedBindings.elements) {
          localNames.push(element.name.text)
        }
      }
    }
    imports.push({ specifier, localNames })
  }
}

function collectClassMembers(
  declaration: ts.ClassDeclaration,
  className: string,
  exportedClass: boolean,
  relativePath: string,
  lineOf: (node: ts.Node) => number,
  sink: {
    symbols: IndexedSymbol[]
    rawMethods: RawMethod[]
    rawLocators: RawLocator[]
    exports: string[]
  },
): void {
  for (const member of declaration.members) {
    const decoratorNames = decoratorsOf(member)
    const docSummary = docSummaryOf(member)

    if (ts.isPropertyDeclaration(member) && member.name) {
      const name = nameOf(member.name)
      const isExported = hasModifier(member, ts.SyntaxKind.ExportKeyword)

      const strategy = member.initializer ? detectLocatorStrategy(member.initializer) : null
      if (strategy && member.initializer) {
        sink.rawLocators.push({
          name,
          ownerClass: className,
          line: lineOf(member),
          expression: member.initializer.getText(),
          strategy,
        })
      }

      sink.symbols.push({
        name,
        kind: 'property',
        file: relativePath,
        line: lineOf(member),
        parent: className,
        exported: isExported,
        parameters: [],
        returnType: typeText(member.type),
        docSummary,
      })
      continue
    }

    if (ts.isMethodDeclaration(member) && member.name) {
      const name = nameOf(member.name)
      const parameters = parametersOf(member.parameters)
      const returnType = typeText(member.type)
      const signature = buildSignature(name, parameters, returnType)

      sink.symbols.push({
        name,
        kind: 'method',
        file: relativePath,
        line: lineOf(member),
        parent: className,
        exported: exportedClass,
        parameters,
        returnType,
        docSummary,
      })

      sink.rawMethods.push({
        name,
        ownerClass: className,
        line: lineOf(member),
        signature,
        parameters,
        returnType,
        decorators: decoratorNames,
        exported: exportedClass,
        docSummary,
        ownerLine: lineOf(declaration),
      })
    }

    if (ts.isConstructorDeclaration(member)) {
      sink.symbols.push({
        name: 'constructor',
        kind: 'constructor',
        file: relativePath,
        line: lineOf(member),
        parent: className,
        exported: exportedClass,
        parameters: parametersOf(member.parameters),
        docSummary,
      })
    }
  }
}

function parametersOf(parameters: ts.NodeArray<ts.ParameterDeclaration>): {
  name: string
  type: string
}[] {
  return parameters.map((param) => ({
    name: nameOf(param.name),
    type: typeText(param.type) ?? 'any',
  }))
}

function buildSignature(
  name: string,
  parameters: { name: string; type: string }[],
  returnType?: string,
): string {
  const parameterText = parameters
    .map((param, index) => `${param.name}${param.type ? `: ${param.type}` : ''}${index === parameters.length - 1 ? '' : ''}`)
    .join(', ')
  const returnSuffix = returnType ? `: ${returnType}` : ''
  return `${name}(${parameterText})${returnSuffix}`
}

function typeText(node: ts.TypeNode | undefined): string | undefined {
  if (!node) return undefined
  const text = node.getText().replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : undefined
}

function nameOf(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isStringLiteral(node)) return node.text
  return node.getText()
}

function decoratorsOf(node: ts.Node): string[] {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  if (!modifiers) return []

  const names: string[] = []
  for (const modifier of modifiers) {
    // ts.getModifiers returns Modifier[] which excludes Decorator at the type
    // level. Route through unknown so ts.isDecorator can narrow correctly.
    if (ts.isDecorator(modifier as unknown as ts.Node)) {
      const dec = modifier as unknown as ts.Decorator
      const text = dec.expression.getText()
      // `@Step(\"...\")` -> `Step`
      const name = text.split(/[(<]/)[0]!.trim()
      if (name.length > 0) names.push(name)
    }
  }
  return names
}

function docSummaryOf(node: ts.Node): string | undefined {
  const jsDocs = ts.getJSDocCommentsAndTags(node)
  const first = jsDocs[0]
  if (!first || !ts.isJSDoc(first)) return undefined

  const comment = first.comment
  const text = (typeof comment === 'string' ? comment : (comment ?? '').toString())
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length === 0) return undefined
  return text.length > 220 ? `${text.slice(0, 217)}...` : text
}

function isExportKeywordPresent(statement: ts.Statement): boolean {
  if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    return true
  }
  // `export default X` / `export { X }`
  return false
}

function hasAbstractModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false)
    : false
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
    : false
}

export function detectLocatorStrategy(node: ts.Expression): LocatorStrategy | null {
  if (ts.isCallExpression(node)) {
    const target = node.expression.getText()
    for (const strategy of [
      'getByRole',
      'getByPlaceholder',
      'getByText',
      'getByLabel',
      'getByTitle',
      'getByTestId',
      'getByAltText',
      'frameLocator',
      'locator',
    ] as const) {
      if (target.endsWith(`.${strategy}`) || target === strategy) {
        if (strategy === 'locator') return 'css'
        return strategy
      }
    }
    if (target.endsWith('.first') || target.endsWith('.last') || target.endsWith('.nth')) {
      return detectLocatorStrategy(node.expression as ts.Expression)
    }
    return null
  }
  return null
}

/**
 * Line numbering is computed from the source text instead of
 * `SourceFile.getLineAndCharacterOfPosition`. That API reaches into an internal
 * `lineMap`, which is absent when the TypeScript instance used to parse differs
 * from the one that built the line index — a real occurrence under Vite, where
 * the transform resolved a second copy of `typescript`. Reading offsets from
 * the string directly has no such dependency.
 */
function createLineIndex(
  source: string,
  sourceFile: ts.SourceFile,
): { line: (node: ts.Node) => number } {
  let lineStarts: number[] | null = null

  const build = (): number[] => {
    const starts: number[] = [0]
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) starts.push(i + 1)
    }
    return starts
  }

  return {
    line: (node: ts.Node) => {
      const start = Math.max(0, node.getStart(sourceFile) ?? 0)
      if (lineStarts === null) lineStarts = build()
      const starts = lineStarts
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid]! <= start) lo = mid
        else hi = mid - 1
      }
      return lo + 1
    },
  }
}

