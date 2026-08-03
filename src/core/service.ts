import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import type {
  BudgetUsage,
  PhaseDefinition,
  PlanAmendment,
  ProjectContract
} from "../domain/model.js";
import { PlaybookStore } from "../storage/playbook.js";
import { ProjectStore } from "../storage/store.js";
import { compileContext } from "./context.js";
import { GitRepository } from "./git.js";
import { indexRepository } from "./indexer.js";
import { ParallelPhaseOrchestrator } from "./orchestrator.js";
import { PhaseVerifier } from "./verifier.js";
import { WorkspaceTools } from "./workspace.js";

const execFileAsync = promisify(execFile);

export class KeepCodingService {
  static async open(projectRoot: string): Promise<KeepCodingService> {
    const git = await GitRepository.open(projectRoot);
    const store = new ProjectStore(git.root);
    const playbook = new PlaybookStore();
    return new KeepCodingService(
      git,
      store,
      new WorkspaceTools(git, store),
      playbook,
      new ParallelPhaseOrchestrator(git, store)
    );
  }

  private constructor(
    readonly git: GitRepository,
    readonly store: ProjectStore,
    readonly workspace: WorkspaceTools,
    readonly playbook: PlaybookStore,
    readonly orchestrator: ParallelPhaseOrchestrator
  ) {}

  close(): void {
    this.playbook.close();
    this.store.close();
  }

  async initialize(prompt: string): Promise<Record<string, unknown>> {
    const project = this.store.initialize(prompt);
    const index = await indexRepository(this.store, this.git);
    return { project, index, playbookEnabled: this.playbook.enabled, nextAction: project.planVersion === 0 ? "save_plan" : "get_context" };
  }

  savePlan(contract: ProjectContract, phases: PhaseDefinition[]): Record<string, unknown> {
    const snapshot = this.store.savePlan(contract, phases);
    return { project: snapshot.project, phases: snapshot.phases, nextAction: "start_phase" };
  }

  amendPlan(amendment: PlanAmendment): Record<string, unknown> {
    const snapshot = this.store.amendPlan(amendment);
    return { project: snapshot.project, phases: snapshot.phases, nextAction: "get_context" };
  }

  context(maxChars?: number): string {
    return compileContext(this.store, maxChars);
  }

  async startPhase(phaseId: string): Promise<Record<string, unknown>> {
    const planned = this.store.getPhase(phaseId);
    if (!planned) throw new Error(`unknown phase: ${phaseId}`);
    if (planned.requiresApproval) {
      const approvals = this.store.listApprovals().filter((item) => item.phaseId === phaseId);
      const approved = approvals.find((item) => item.status === "approved");
      if (!approved) {
        const pending = approvals.find((item) => item.status === "pending");
        const requested = pending ?? this.store.requestApproval(
          phaseId,
          `Approve phase ${phaseId}?`,
          `${planned.title}: ${planned.goal}`
        );
        return { phase: this.store.getPhase(phaseId), approval: requested, nextAction: "resolve_approval" };
      }
    }
    this.store.setPhaseBaseline(phaseId, await this.git.workingTreeSnapshot());
    this.store.setRestoreSnapshot(phaseId, await this.git.captureScopeSnapshot(planned.allowedScope));
    const phase = this.store.startPhase(phaseId, await this.git.headSha());
    return { phase, context: this.context(), nextAction: "implement_and_checkpoint" };
  }

  async checkpoint(phaseId: string, summary: string, usage: BudgetUsage = {}): Promise<Record<string, unknown>> {
    const phase = this.store.getPhase(phaseId);
    if (!phase) throw new Error(`unknown phase: ${phaseId}`);
    const baseline = this.store.getPhaseBaseline(phaseId) ?? undefined;
    const changedFiles = baseline ? await this.git.changedFilesSince(baseline) : await this.git.changedFiles();
    const impactedFiles = expandImpactedFiles(this.store, changedFiles);
    const impactedTests = this.store.impactedTests(changedFiles);
    const impactedCompletedPhases = this.store.completedPhasesImpactedByFiles(impactedFiles, phaseId);
    const measuredUsage = withMeasuredWallClock(usage, phase.startedAt);
    this.store.markVerifying(phaseId);
    const verifying = this.store.getPhase(phaseId);
    if (!verifying) throw new Error(`unknown phase: ${phaseId}`);
    const evidence = await new PhaseVerifier().verify(this.git, verifying, baseline, {
      contract: this.store.getProject()?.contract,
      usage: measuredUsage,
      impactedTests
    });

    if (evidence.passed) {
      const commitSha = await this.git.commitFiles(evidence.changedFiles, `keep-coding(${phaseId}): ${summary}`);
      evidence.checkpointCommitSha = commitSha;
      evidence.gitSha = await this.git.headSha();
    }
    const updated = this.store.finishVerification(phaseId, summary, evidence);
    if (evidence.passed) {
      await indexRepository(this.store, this.git);
      this.store.markNeedsReverification(impactedCompletedPhases, phaseId);
      const project = this.store.getProject();
      if (project?.contract) this.playbook.rememberPhase(updated, project.contract);
    }
    return {
      phase: updated,
      evidence,
      impactedFiles,
      impactedCompletedPhases,
      project: this.store.getProject(),
      canRestore: !evidence.passed && this.store.getRestoreSnapshot(phaseId) !== null,
      nextAction: evidence.passed ? (this.store.currentPhase() ? "start_phase" : "complete_project") : "repair_or_restore_phase"
    };
  }

  async restorePhase(phaseId: string): Promise<Record<string, unknown>> {
    const phase = this.store.getPhase(phaseId);
    if (!phase) throw new Error(`unknown phase: ${phaseId}`);
    if (!["FAILED", "BLOCKED", "BLOCKED_BUDGET"].includes(phase.status)) {
      throw new Error(`phase ${phaseId} cannot be restored from ${phase.status}`);
    }
    const snapshot = this.store.getRestoreSnapshot(phaseId);
    const baseline = this.store.getPhaseBaseline(phaseId);
    if (!snapshot || !baseline) throw new Error(`phase ${phaseId} has no restore snapshot`);
    const changedFiles = (await this.git.changedFilesSince(baseline)).filter((file) =>
      phase.allowedScope.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: false }))
    );
    const restoredFiles = await this.git.restoreScopeSnapshot(snapshot, changedFiles);
    this.store.appendEvent("phase_restored_to_baseline", phaseId, { restoredFiles });
    return { phaseId, restoredFiles, nextAction: "start_phase" };
  }

  requestApproval(phaseId: string, question: string, details: string): Record<string, unknown> {
    return { approval: this.store.requestApproval(phaseId, question, details), nextAction: "resolve_approval" };
  }

  resolveApproval(approvalId: string, approved: boolean, response: string): Record<string, unknown> {
    const approval = this.store.resolveApproval(approvalId, approved, response);
    return { approval, phase: this.store.getPhase(approval.phaseId), nextAction: approved ? "start_phase" : "amend_plan_or_intervene" };
  }

  recordFailure(phaseId: string, summary: string, fingerprint?: string): Record<string, unknown> {
    const failure = this.store.recordFailure(phaseId, summary, fingerprint);
    this.playbook.rememberFailure(failure);
    return { failure, repeated: failure.count > 1 };
  }

  getImpact(subject: string, maxDepth?: number): Record<string, unknown> {
    return { impact: this.store.getImpact(subject, maxDepth) };
  }

  suggestPhases(query: string, limit?: number): Record<string, unknown> {
    return { enabled: this.playbook.enabled, suggestions: this.playbook.suggest(query, limit) };
  }

  async prepareParallelPhases(limit?: number): Promise<Record<string, unknown>> {
    const workspaces = await this.orchestrator.prepare(limit);
    return { workspaces, nextAction: "run_each_phase_in_its_worktree" };
  }

  async mergeParallelPhase(phaseId: string): Promise<Record<string, unknown>> {
    const merged = await this.orchestrator.merge(phaseId);
    await indexRepository(this.store, this.git);
    return { ...merged, nextAction: "start_phase_and_checkpoint" };
  }

  async discardParallelPhase(phaseId: string): Promise<Record<string, unknown>> {
    return this.orchestrator.discard(phaseId);
  }

  async completeProject(): Promise<Record<string, unknown>> {
    const projectBeforeGate = this.store.getProject();
    if (projectBeforeGate?.status !== "READY_TO_COMPLETE") {
      throw new Error("project must be READY_TO_COMPLETE before the full-suite gate runs");
    }
    const gate = await runCompletionGate(this.git.root);
    if (gate && !gate.passed) {
      this.store.appendEvent("project_completion_gate_failed", null, gate);
      throw new Error(`full-suite completion gate failed: ${gate.command}\n${gate.output}`);
    }
    const project = this.store.completeProject();
    this.store.appendEvent("project_completion_gate_passed", null, gate ?? { command: null, skipped: true });
    return { project, fullSuiteGate: gate, nextAction: "report_completion" };
  }
}

export function expandImpactedFiles(store: ProjectStore, changedFiles: string[]): string[] {
  const impacted = new Set(changedFiles);
  for (const file of changedFiles) {
    for (const related of store.getImpact(file, 4).files) impacted.add(related);
  }
  return [...impacted].sort();
}

export function withMeasuredWallClock(usage: BudgetUsage, startedAt: string | null): BudgetUsage {
  if (usage.wallClockMs !== undefined || !startedAt) return usage;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return usage;
  return { ...usage, wallClockMs: Math.max(0, Date.now() - started) };
}

async function runCompletionGate(root: string): Promise<{ command: string; passed: boolean; durationMs: number; output: string } | null> {
  const packageJson = await readJson(path.join(root, "package.json"));
  const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : {};
  let executable: string | null = null;
  let args: string[] = [];
  let command = "";
  if (typeof scripts.check === "string") {
    executable = process.platform === "win32" ? "npm.cmd" : "npm";
    args = ["run", "check"];
    command = "npm run check";
  } else if (typeof scripts.test === "string") {
    executable = process.platform === "win32" ? "npm.cmd" : "npm";
    args = ["test"];
    command = "npm test";
  } else if (await fileExists(path.join(root, "pyproject.toml"))) {
    executable = process.platform === "win32" ? "python.exe" : "python3";
    args = ["-m", "pytest"];
    command = "python -m pytest";
  }
  if (!executable) return null;
  const started = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    });
    return { command, passed: true, durationMs: Math.round(performance.now() - started), output: `${stdout}${stderr}`.slice(-12_000) };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return {
      command,
      passed: false,
      durationMs: Math.round(performance.now() - started),
      output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message}`.slice(-12_000)
    };
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fileExists(file: string): Promise<boolean> {
  return readFile(file).then(() => true).catch(() => false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
