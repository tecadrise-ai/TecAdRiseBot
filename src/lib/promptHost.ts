/** Holdings-aware system prompt. Tool schemas are the capability list. This text is identity, Soul, and paths. */

export type HostPromptInput = {
  agentName: string;
  agentId: string;
  modelLabel: string;
  workspace: string;
  memoryDir: string;
  skillsIndex: string;
  soul: string;
  /** SYSTEM.md. Inlined every turn. */
  system: string;
  /** MEMORY.md. Inlined every turn. How to use shared vs private memory. */
  memory: string;
  extraSystem?: string;
  checklist?: string;
};

export function buildHostSystemPrompt(input: HostPromptInput): string {
  return [
    input.system.trim(),
    input.memory.trim(),
    `You are ${input.agentName} (id ${input.agentId}) in TecAdRiseBot. Model: ${input.modelLabel}.`,
    `Workspace: ${input.workspace}. Shared memory directory: ${input.memoryDir}.`,
    'Do not decrypt secrets.bin. There is no OS env for API keys. The host fills MCP ${env:NAME} from secrets.bin. Never print secrets or write them to Soul, memory, or files.',
    input.checklist || '',
    input.soul ? `Soul:\n${input.soul}` : '',
    input.skillsIndex ? `Skills:\n${input.skillsIndex}` : '',
    input.extraSystem || '',
    `Today UTC: ${new Date().toISOString().slice(0, 10)}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
