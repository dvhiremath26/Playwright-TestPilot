/**
 * Agent orchestration contracts: the task state machine, execution stages,
 * plans, proposed changes, and validation results.
 */
import type { TestCase } from './test-case.ts'

/** The explicit task lifecycle required by the product spec. */
export type TaskStatus =
  | 'Created'
  | 'InputValidated'
  | 'RepositoryAnalyzing'
  | 'ReuseAnalyzing'
  | 'Planning'
  | 'AwaitingApproval'
  | 'ApplyingChanges'
  | 'Applied'
  | 'Validating'
  | 'RepairProposed'
  | 'Completed'
  | 'Failed'
  | 'Cancelled'

/** The agent execution cycle from the spec. */
export type AgentStage = 'Understand' | 'Observe' | 'Retrieve' | 'Browse' | 'Plan' | 'Decide' | 'Act' | 'Verify' | 'Recover' | 'Report'

/** Which agent stage a task is currently in. */
export type StageStatus = 'pending' | 'in-progress' | 'completed' | 'skipped' | 'failed'

export interface StageRecord {
  stage: AgentStage
  status: StageStatus
  startedAt?: string
  completedAt?: string
  /** What the stage concluded. Provenance for the report. */
  summary?: string
}

/** A proposed or applied file change. */
export interface FileChange {
  /** Repository-relative path. */
  path: string
  kind: 'create' | 'modify' | 'delete'
  /** Full new content for creates; complete rewritten content for modifies. */
  newContent?: string
  /** Original content for modifies, used to build the diff. */
  originalContent?: string
  /** Unified diff text. */
  diff?: string
  /** Why this change is necessary, citing evidence. */
  reason: string
  /** Evidence that this change matches framework conventions. */
  evidence: string[]
}

/** An entry in the step-to-implementation plan. */
export type PlanResolution =
  | 'existing-method'
  | 'existing-page-object'
  | 'existing-locator'
  | 'existing-action'
  | 'new-method'
  | 'new-locator'
  | 'assertion'
  | 'unresolved'

export interface PlanEntry {
  /** 1-based step order from the manual test case. */
  stepOrder: number
  /** The action text of the step. */
  stepAction: string
  /** The expected result of the step, if any. */
  stepExpected?: string
  resolution: PlanResolution
  /** File and symbol the step maps to. */
  targetFile?: string
  targetSymbol?: string
  /** Namespace path on the facade, e.g. `validation.expectVisible`. */
  facadePath?: string
  /** File paths and symbol names proving the mapping. */
  evidence: string[]
  /** Set when the step cannot be implemented without more information. */
  unresolvedReason?: string
  /** Explicitly user-selected locator generated from a live browser reference. */
  verifiedLocator?: VerifiedLocator
}

export interface VerifiedLocator {
  ref: string
  role?: string
  name?: string
  expression: string
  backend: string
  observedAt: string
  /** Manual step this locator was observed for, when step replay was enabled. */
  stepOrder?: number
  /** URL of the screen where this locator was observed. */
  pageUrl?: string
}

/** A decision about what to do with the test case as a whole. */
export interface TestCaseDecision {
  decision:
    | 'reuse-existing'
    | 'update-existing'
    | 'create-new'
    | 'needs-clarification'
    | 'needs-browser-evidence'
  /** Why the agent decided this. */
  rationale: string
  /** Evidence supporting the decision. */
  evidence: string[]
  /** Target spec file when reusing or updating. */
  targetTestFile?: string
}

/** Reuse analysis for a single manual step. */
export interface StepReusePlan {
  stepOrder: number
  /** Candidate methods ranked best-first. */
  candidateMethods: CandidateMethod[]
  /** Locators that could serve this step. */
  candidateLocators: CandidateLocator[]
  /** Page objects relevant to this step. */
  candidatePageObjects: string[]
}

export interface CandidateMethod {
  /** `Class.method` or `namespace.method`. */
  qualifiedName: string
  file: string
  line: number
  signature: string
  /** How the candidate was scored. */
  matchReason: string
  /** 0-1. Deterministic; never the sole basis for a decision. */
  confidence: number
}

export interface CandidateLocator {
  name: string
  ownerClass: string
  file: string
  line: number
  expression: string
  matchReason: string
  confidence: number
}

/** Result of duplicate detection. */
export type DuplicateVerdict =
  | 'exact-duplicate'
  | 'likely-duplicate'
  | 'related-but-different'
  | 'shared-workflow-different-outcome'
  | 'no-overlap'

export interface DuplicateFinding {
  verdict: DuplicateVerdict
  /** The existing test considered. */
  existingTest: { title: string; file: string; line: number; xrayKey?: string }
  /** Concrete reasons, always more than a similarity number. */
  evidence: string[]
  /** 0-1 similarity, supporting evidence only. */
  similarity: number
  recommendation: string
}

export interface ReuseReport {
  /** The test case this report is about. */
  testCaseTitle: string
  /** The create/reuse/update decision, with its rationale and evidence. */
  decision: TestCaseDecision
  duplicates: DuplicateFinding[]
  stepReuse: StepReusePlan[]
  /** Candidate helper methods across the whole case. */
  helperMethods: CandidateMethod[]
  /** Relevant page objects. */
  pageObjects: CandidateMethod[]
  /** Locator modules relevant to the case. */
  locatorModules: CandidateMethod[]
  /** Capabilities the framework does not provide. */
  missingFunctionality: string[]
  /** Overall confidence, with reasons. */
  confidence: { score: number; reasons: string[] }
}

/** One command actually executed during validation. */
export interface CommandResult {
  command: string
  /** Working directory. */
  cwd: string
  exitCode: number | null
  /** True when the command ran to completion and its exit code was observed. */
  executed: boolean
  durationMs: number
  stdout: string
  stderr: string
  /** Set when the command could not be run at all. */
  skipReason?: string
  timedOut?: boolean
}

export type ValidationCheckKind = 'diff' | 'paths' | 'unrelated-files' | 'lint' | 'typecheck' | 'test'

export interface ValidationCheck {
  kind: ValidationCheckKind
  description: string
  passed: boolean
  /** What actually happened. */
  detail: string
  /** Commands that ran for this check. */
  commands: CommandResult[]
  /** True when the check was skipped and never ran. */
  skipped: boolean
  skipReason?: string
}

export interface ValidationReport {
  taskId: string
  checks: ValidationCheck[]
  passed: boolean
  /** Counts of what actually ran. */
  summary: { passed: number; failed: number; skipped: number; unexecuted: number }
  /** Failure analysis, when something failed. */
  failureAnalysis?: FailureAnalysis
}

export interface FailureAnalysis {
  /** Likely cause, grounded in evidence. */
  likelyCause: string
  /** The evidence supporting the cause. */
  evidence: string[]
  /** Where the failure occurred. */
  location?: { file: string; line?: number }
  /** Smallest proposed correction. */
  proposedCorrection?: string
  /** True when the agent could not determine the cause. */
  unresolved: boolean
}

/** A checkpoint enabling a resumed task to skip completed work. */
export interface TaskCheckpoint {
  taskId: string
  /** Repository state at checkpoint time, used to detect drift. */
  repositoryState: RepositoryStateSnapshot
  status: TaskStatus
  stageRecords: StageRecord[]
  /** Opaque per-task data the stages produce. */
  stageData: Record<string, unknown>
  savedAt: string
}

export interface RepositoryStateSnapshot {
  repositoryRoot: string
  /** HEAD commit, when Git is available. */
  headCommit?: string
  /** Current branch. */
  branch?: string
  /** Fingerprint of `git status --porcelain`, including untracked files. */
  workingTreeFingerprint?: string
  /** SHA-256 fingerprints of files this task touched. */
  fileFingerprints: Record<string, string>
  /** True when Git was unavailable and only fingerprints were captured. */
  gitUnavailable?: boolean
}

/** Persistent task record. */
export interface TaskRecord {
  taskId: string
  title: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  repositoryRoot: string
  /** Source state captured when the plan was created; used before resume/apply. */
  repositorySnapshot?: RepositoryStateSnapshot
  /** Source of the manual test case. */
  testCaseSource: string
  /** Normalized source case, retained for deterministic change emission. */
  testCase?: TestCase
  /** All cases when the user supplied a batch of titled manual tests. */
  testCases?: TestCase[]
  stages: StageRecord[]
  decision?: TestCaseDecision
  reuseReport?: ReuseReport
  plan?: PlanEntry[]
  /** Locators generated from observed browser refs; not assigned to steps until selected. */
  browserLocatorCandidates?: VerifiedLocator[]
  /** Number of repair proposals made; bounded by the runner/CLI policy. */
  repairAttempts?: number
  proposedChanges: FileChange[]
  appliedChanges: string[]
  /** Fingerprints of applied files as last written by TestPilot. */
  appliedFileFingerprints?: Record<string, string>
  validation?: ValidationReport
  /** Failure details when the task failed. */
  error?: { message: string; stage: AgentStage }
  /** Metadata about the model calls made. */
  modelCalls: { provider: string; model?: string; at: string; purpose: string }[]
}
