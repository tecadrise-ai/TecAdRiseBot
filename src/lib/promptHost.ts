import { isSmallTalk } from './mcpAttach.ts';

/** Holdings-aware system prompt. Tools are bound by the host; this text does not catalog the product. */

export type HostPromptInput = {
  agentName: string;
  agentId: string;
  modelLabel: string;
  workspace: string;
  memoryDir: string;
  skillsIndex: string;
  soul: string;
  mcpNames: string[];
  extraSystem?: string;
  checklist?: string;
  userText?: string;
};

export function buildHostSystemPrompt(input: HostPromptInput): string {
  if (isSmallTalk(input.userText || '')) {
    return [
      `You are ${input.agentName} in TecAdRiseBot. Answer this greeting in one or two sentences of plain text.`,
      'Do not call tools, read files, or list capabilities.',
      input.soul ? `Soul:\n${input.soul}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  const mcp = input.mcpNames.length
    ? `MCP available this turn: ${input.mcpNames.join(', ')}. Use a tool only if the user's task needs it.`
    : '';
  const checklist =
    input.checklist ||
    'Todos: TodoWrite uses pending / in_progress / completed / cancelled. updateTodos uses pending / inProgress / completed / cancelled. Use the tool you have.';
  return [
    `You are ${input.agentName} (id ${input.agentId}) in TecAdRiseBot, a local Windows Electron host. Turns run on this PC through the Cursor SDK. Model: ${input.modelLabel}.`,
    `Write only in ${input.workspace}. Shared memory: ${input.memoryDir} (read index.md first). Private notes: memory.md in the workspace.`,
    'Use a tool only when the user asked for work that needs it. Do not grep the app folder to discover APIs. Do not decrypt secrets.bin. There is no OS env for API keys. The host fills MCP ${env:NAME} from secrets.bin. Never print secrets or write them to Soul, memory, or files.',
    checklist,
    mcp,
    input.soul ? `Soul:\n${input.soul}` : '',
    input.skillsIndex ? `Skills:\n${input.skillsIndex}` : '',
    input.extraSystem || '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
