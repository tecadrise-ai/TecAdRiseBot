import type { WorkflowRun } from './lib/workflow/types';

export type Agent = {
  id: string;
  name: string;
  color: string;
  model: string;
  cursorAgentId: string | null;
  lastSnippet: string | null;
  instructions: string | null;
  config: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'interbot';
  content: string;
  meta: string | null;
  createdAt: number;
};

export type Routine = {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: number;
  forceTodos: number;
  workflowId: string | null;
  lastRunAt: number | null;
  createdAt: number;
};

export type { Workflow, WorkflowRun, RunState, StepStatus } from './lib/workflow/types';

/** Run as sent to the UI (no runner token). */
export type WorkflowRunView = Omit<WorkflowRun, 'token'> & {
  runnerName: string;
  runnerModel: string;
  ownerName: string;
  inFlight: string | null;
};

export type AppSettings = {
  hasApiKey: boolean;
  selectedModel: string;
  accountName: string;
  userDataPath: string;
  memoryPath: string;
  skillsPath: string;
  version: string;
  platform: string;
  missedGraceMinutes: number;
};
