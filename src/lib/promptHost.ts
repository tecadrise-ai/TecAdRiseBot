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
  extraSystem?: string;
  checklist?: string;
};

export function buildHostSystemPrompt(input: HostPromptInput): string {
  return [
    input.system.trim(),
    `You are ${input.agentName} (id ${input.agentId}) in TecAdRiseBot. Model: ${input.modelLabel}.`,
    `Write only in ${input.workspace}. Shared memory: ${input.memoryDir}. Private notes: memory.md in the workspace.`,
    'You decide when memory, files, skills, or tools help the job. If you need a shared fact, open index.md in the memory directory, then the linked note. Do not glob or list the workspace to look around. Do not decrypt secrets.bin. There is no OS env for API keys. The host fills MCP ${env:NAME} from secrets.bin. Never print secrets or write them to Soul, memory, or files.',
    input.checklist || '',
    input.soul ? `Soul:\n${input.soul}` : '',
    input.skillsIndex ? `Skills:\n${input.skillsIndex}` : '',
    input.extraSystem || '',
    `Today UTC: ${new Date().toISOString().slice(0, 10)}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
