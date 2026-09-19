export type ModelParam = { id: string; value: string };

export type CatalogParam = {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
};

export type CatalogVariant = {
  displayName: string;
  description?: string;
  isDefault?: boolean;
  params: ModelParam[];
};

export type CatalogModel = {
  id: string;
  displayName: string;
  parameters?: CatalogParam[];
  variants?: CatalogVariant[];
};

export type ModelMode = 'usual' | 'fast';

export const DEFAULT_MODEL_ID = 'composer-2.5';
export const DEFAULT_MODE: ModelMode = 'usual';
export const DEFAULT_EFFORT = 'medium';

export const FALLBACK_EFFORT_VALUES = [
  { value: 'low', displayName: 'Low' },
  { value: 'medium', displayName: 'Medium' },
  { value: 'high', displayName: 'High' },
  { value: 'max', displayName: 'Max' },
];

export function baseModelId(id: string): string {
  return String(id || DEFAULT_MODEL_ID).replace(/-fast$/i, '');
}

export function isFastModelId(id: string): boolean {
  return /-fast$/i.test(String(id || ''));
}

export function readModelMode(config: Record<string, unknown> | null | undefined, modelId: string): ModelMode {
  const raw = String(config?.modelMode || '').toLowerCase();
  if (raw === 'fast' || raw === 'usual') return raw;
  return isFastModelId(modelId) ? 'fast' : DEFAULT_MODE;
}

export function readEffort(config: Record<string, unknown> | null | undefined): string {
  const raw = String(config?.effort || '').trim().toLowerCase();
  if (raw) return raw;
  return DEFAULT_EFFORT;
}

export function dropdownModels(models: CatalogModel[]): CatalogModel[] {
  const ids = new Set(models.map((m) => m.id));
  return models.filter((m) => !(isFastModelId(m.id) && ids.has(baseModelId(m.id))));
}

export function effortParam(model: CatalogModel | undefined): CatalogParam {
  const found = (model?.parameters || []).find((p) => {
    const blob = `${p.id} ${p.displayName || ''}`.toLowerCase();
    return /effort|thinking|reason/.test(blob);
  });
  if (found && found.values.length) return found;
  return { id: found?.id || 'effort', displayName: found?.displayName || 'Effort', values: FALLBACK_EFFORT_VALUES };
}

export const DEFAULT_LAST_MESSAGES = 5;
export const MAX_LAST_MESSAGES = 50;

export function cheapDefaultConfig(): { modelMode: ModelMode; effort: string; lastMessages: number } {
  return { modelMode: DEFAULT_MODE, effort: DEFAULT_EFFORT, lastMessages: DEFAULT_LAST_MESSAGES };
}

export function readLastMessages(config: Record<string, unknown> | null | undefined): number {
  if (config == null || !Object.prototype.hasOwnProperty.call(config, 'lastMessages')) {
    return DEFAULT_LAST_MESSAGES;
  }
  const n = Number(config.lastMessages);
  if (!Number.isFinite(n)) return DEFAULT_LAST_MESSAGES;
  return Math.max(0, Math.min(MAX_LAST_MESSAGES, Math.round(n)));
}

export function shouldRecreateSdkAgent(
  prev: { model: string; config: Record<string, unknown> | null },
  patch: { model?: string; config?: Record<string, unknown> | null }
): boolean {
  if (patch.model !== undefined && patch.model !== prev.model) return true;
  if (patch.config === undefined) return false;
  const nextModel = patch.model ?? prev.model;
  if (readModelMode(patch.config, nextModel) !== readModelMode(prev.config, prev.model)) return true;
  if (readEffort(patch.config) !== readEffort(prev.config)) return true;
  return false;
}

export function toSdkModel(
  modelId: string,
  config: Record<string, unknown> | null | undefined,
  catalog?: CatalogModel[]
): { id: string; params?: ModelParam[] } {
  const mode = readModelMode(config, modelId);
  const effort = readEffort(config);
  let id = baseModelId(modelId);
  const item = (catalog || []).find((m) => m.id === id || m.id === modelId);
  const params: ModelParam[] = [];

  if (mode === 'fast') {
    const fastVar = (item?.variants || []).find((v) => /fast/i.test(v.displayName));
    if (fastVar?.params?.length) params.push(...fastVar.params);
    else id = `${id}-fast`;
  } else {
    const pick =
      (item?.variants || []).find((v) => v.isDefault && !/fast/i.test(v.displayName)) ||
      (item?.variants || []).find((v) => !/fast/i.test(v.displayName));
    if (pick?.params?.length) params.push(...pick.params);
  }

  const ep = effortParam(item);
  const idx = params.findIndex((p) => p.id === ep.id);
  if (idx >= 0) params[idx] = { id: ep.id, value: effort };
  else params.push({ id: ep.id, value: effort });

  return { id, params };
}

export function formatModelLabel(
  modelId: string,
  config: Record<string, unknown> | null | undefined
): string {
  const id = baseModelId(modelId);
  const mode = readModelMode(config, modelId);
  const effort = readEffort(config);
  return `${id} · ${mode} · ${effort}`;
}
