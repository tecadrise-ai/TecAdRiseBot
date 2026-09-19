import { contextBridge, ipcRenderer } from 'electron';

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
  lastRunAt: number | null;
  createdAt: number;
};

const api = {
  agents: {
    list: (): Promise<Agent[]> => ipcRenderer.invoke('agents:list'),
    busy: (): Promise<string[]> => ipcRenderer.invoke('agents:busy'),
    create: (name: string, model?: string): Promise<Agent> =>
      ipcRenderer.invoke('agents:create', name, model),
    update: (
      id: string,
      patch: {
        name?: string;
        model?: string;
        color?: string;
        instructions?: string | null;
        config?: Record<string, unknown> | null;
      }
    ) => ipcRenderer.invoke('agents:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('agents:delete', id),
  },
  messages: {
    list: (agentId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('messages:list', agentId),
  },
  usage: {
    byAgent: (): Promise<
      Array<{
        agentId: string;
        name: string;
        color: string;
        replies: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        totalTokens: number;
      }>
    > => ipcRenderer.invoke('usage:byAgent'),
  },
  chat: {
    send: (agentId: string, text: string, attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>) =>
      ipcRenderer.invoke('chat:send', agentId, text, attachments ?? []),
    stop: (agentId: string) => ipcRenderer.invoke('chat:stop', agentId),
  },
  interbot: {
    send: (fromAgentId: string, toAgentId: string, text: string) =>
      ipcRenderer.invoke('interbot:send', fromAgentId, toAgentId, text),
  },
  controlPlane: {
    info: (): Promise<{ port: number; baseUrl: string }> =>
      ipcRenderer.invoke('controlPlane:info'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setApiKey: (key: string) => ipcRenderer.invoke('settings:setApiKey', key),
    clearApiKey: () => ipcRenderer.invoke('settings:clearApiKey'),
    setModel: (model: string) => ipcRenderer.invoke('settings:setModel', model),
    setAccountName: (name: string) => ipcRenderer.invoke('settings:setAccountName', name),
    getSystemPrompt: (): Promise<string> => ipcRenderer.invoke('settings:getSystemPrompt'),
    setSystemPrompt: (text: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('settings:setSystemPrompt', text),
    getSystemMemory: (): Promise<string> => ipcRenderer.invoke('settings:getSystemMemory'),
    setSystemMemory: (text: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('settings:setSystemMemory', text),
  },
  models: {
    list: (): Promise<
      Array<{
        id: string;
        displayName: string;
        parameters?: Array<{
          id: string;
          displayName?: string;
          values: Array<{ value: string; displayName?: string }>;
        }>;
        variants?: Array<{
          displayName: string;
          description?: string;
          isDefault?: boolean;
          params: Array<{ id: string; value: string }>;
        }>;
      }>
    > => ipcRenderer.invoke('models:list'),
  },
  routines: {
    list: (): Promise<Routine[]> => ipcRenderer.invoke('routines:list'),
    create: (input: { agentId: string; name: string; cron: string; prompt: string }) =>
      ipcRenderer.invoke('routines:create', input),
    update: (
      id: string,
      patch: Partial<{ name: string; cron: string; prompt: string; enabled: number }>
    ) => ipcRenderer.invoke('routines:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('routines:delete', id),
    runNow: (id: string) => ipcRenderer.invoke('routines:runNow', id),
  },
  app: {
    openPath: (p: string) => ipcRenderer.invoke('app:openPath', p),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const allowed = [
      'chat:message',
      'chat:stream-start',
      'chat:stream-delta',
      'chat:stream-done',
      'chat:stream-error',
      'routines:fired',
    ];
    if (!allowed.includes(channel)) return () => undefined;
    const wrapped = (_: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('tecapi', api);

export type TecApi = typeof api;
