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
  lastRunAt: number | null;
  createdAt: number;
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
};
