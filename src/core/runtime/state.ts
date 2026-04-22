import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GuardrailError } from '../errors.ts';

export type PipelineStep =
  | 'plan' | 'worktree' | 'implement' | 'migrate' | 'validate'
  | 'push' | 'create-pr' | 'review' | 'bugbot';

export type StepStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
export type RunStatus = 'in-progress' | 'completed' | 'failed' | 'superseded';

export interface StepState {
  status: StepStatus;
  idempotencyKey?: string;
  artifact?: string;
  errorCode?: string;
  attempts?: number;
  lastCommitSha?: string;
  appliedMigrations?: string[];
  prNumber?: number;
  alreadyExisted?: boolean;
}

export interface RunState {
  runId: string;
  topic: string;
  startedAt: string;
  lastUpdatedAt: string;
  status: RunStatus;
  currentStep: PipelineStep | null;
  steps: Record<PipelineStep, StepState>;
}

export const ALL_STEPS: readonly PipelineStep[] = Object.freeze([
  'plan', 'worktree', 'implement', 'migrate', 'validate', 'push', 'create-pr', 'review', 'bugbot',
]);

function stateFile(runId: string, runsDir: string): string {
  return path.join(runsDir, runId, 'state.json');
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

export interface CreateRunStateOptions {
  runId: string;
  topic: string;
  runsDir?: string;
}

export async function createRunState(options: CreateRunStateOptions): Promise<RunState> {
  const runsDir = options.runsDir ?? path.join('.claude', 'runs');
  await fs.mkdir(path.join(runsDir, options.runId), { recursive: true });
  const now = new Date().toISOString();
  const stepsInit = {} as Record<PipelineStep, StepState>;
  for (const step of ALL_STEPS) stepsInit[step] = { status: 'pending' };
  const state: RunState = {
    runId: options.runId, topic: options.topic,
    startedAt: now, lastUpdatedAt: now,
    status: 'in-progress', currentStep: null, steps: stepsInit,
  };
  await writeAtomic(stateFile(options.runId, runsDir), JSON.stringify(state, null, 2));
  return state;
}

export async function loadRunState(runId: string, runsDir?: string): Promise<RunState> {
  const dir = runsDir ?? path.join('.claude', 'runs');
  const file = stateFile(runId, dir);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as RunState;
  } catch (err) {
    throw new GuardrailError(`Run state not found: ${runId}`, {
      code: 'user_input',
      details: { runId, file, cause: err instanceof Error ? err.message : String(err) },
    });
  }
}

export interface UpdateStepOptions {
  runId: string;
  runsDir?: string;
  step: PipelineStep;
  update: Partial<StepState>;
}

export async function updateStepStatus(options: UpdateStepOptions): Promise<RunState> {
  const runsDir = options.runsDir ?? path.join('.claude', 'runs');
  const state = await loadRunState(options.runId, runsDir);
  state.steps[options.step] = { ...state.steps[options.step], ...options.update };
  state.lastUpdatedAt = new Date().toISOString();
  if (options.update.status === 'in-progress') state.currentStep = options.step;
  await writeAtomic(stateFile(options.runId, runsDir), JSON.stringify(state, null, 2));
  return state;
}
