/**
 * Which optional MCP servers this message needs.
 * Agent JSON and workflow extra MCP always attach. Global MCP + Connectors are optional:
 * small talk gets none; a clear job gets the matching servers; unknown work gets none of them
 * (Cursor SDK tools still run). Fail-open would put Zoho and Playwright on every VPS turn.
 */

const SMALL_TALK = /^(hi|hello|hey|yo|thanks|thank you|ok|okay|cześć|hej|dzieki|dzięki)[\s!.?]*$/i;

/** MCP server name → phrases in the user/routine text. */
const HINTS: Record<string, string[]> = {
  playwright: ['playwright', 'browser', 'screenshot', 'scrape', 'web page', 'webpage', 'chromium'],
  github: ['github', 'pull request', ' repo', 'repository', 'commit', 'gh '],
  zoho_mail: ['email', 'e-mail', 'eamil', 'inbox', 'zoho', 'poczta', 'skrzynka', 'mailbox', 'mail'],
  zoho: ['email', 'e-mail', 'eamil', 'inbox', 'zoho', 'poczta', 'skrzynka', 'mailbox', 'mail'],
  agentmail: ['agentmail', 'breakoutbot@'],
  elevenlabs: ['elevenlabs', 'eleven labs', 'text to speech', 'tts'],
  canva: ['canva'],
  context: ['context.dev', 'context ai'],
  treg: ['treg'],
};

function haystack(text: string): string {
  return ` ${text.toLowerCase()} `;
}

function matchesHint(name: string, text: string): boolean {
  const phrases = HINTS[name.toLowerCase()] || HINTS[name] || [name.toLowerCase().replace(/_/g, ' ')];
  const h = haystack(text);
  return phrases.some((p) => h.includes(p.toLowerCase()));
}

export function isSmallTalk(text: string): boolean {
  return SMALL_TALK.test(text.trim());
}

export function selectOptionalMcp(available: string[], current: string, prior = ''): string[] {
  const names = available.filter(Boolean);
  if (!names.length) return [];
  if (isSmallTalk(current)) return [];
  const text = [current, prior].filter(Boolean).join('\n');
  return names.filter((n) => matchesHint(n, text));
}

export function pickMcpServers<T>(
  always: Record<string, T>,
  optional: Record<string, T>,
  current: string,
  prior = ''
): Record<string, T> {
  const keep = new Set(selectOptionalMcp(Object.keys(optional), current, prior));
  const out: Record<string, T> = { ...always };
  for (const [name, server] of Object.entries(optional)) {
    if (keep.has(name)) out[name] = server;
  }
  return out;
}

export function needsWorkflowTools(text: string): boolean {
  if (isSmallTalk(text)) return false;
  return /\b(workflow|workflows|step_current|workflow_save|review_verdict)\b/i.test(text);
}
