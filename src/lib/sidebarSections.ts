export const HIDDEN_SECTION_ID = 'hidden';
export const HIDDEN_SECTION_NAME = 'Hidden';

export type SidebarSection = { id: string; name: string };

export type SidebarLayout = {
  sections: SidebarSection[];
  membership: Record<string, string>;
  collapsed: string[];
  /** Mix of unassigned agent ids and section ids. Hidden is never listed. */
  order: string[];
};

export function emptyLayout(): SidebarLayout {
  return { sections: [], membership: {}, collapsed: [HIDDEN_SECTION_ID], order: [] };
}

function slugName(name: string): string {
  const t = name.trim().replace(/\s+/g, ' ');
  return t.slice(0, 40) || 'Section';
}

function rebuildOrder(layout: SidebarLayout, agentIds: string[]): string[] {
  const sectionIds = new Set(layout.sections.map((s) => s.id));
  const unassigned = new Set(
    agentIds.filter((id) => {
      const s = layout.membership[id];
      return !s || (s !== HIDDEN_SECTION_ID && !sectionIds.has(s));
    })
  );
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of layout.order) {
    if (seen.has(id) || id === HIDDEN_SECTION_ID) continue;
    if (sectionIds.has(id) || unassigned.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const id of agentIds) {
    if (unassigned.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const s of layout.sections) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      order.push(s.id);
    }
  }
  return order;
}

export function normalizeLayout(raw: unknown, agentIds: string[] = []): SidebarLayout {
  const known = new Set(agentIds);
  const out = emptyLayout();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    out.order = rebuildOrder(out, agentIds);
    return out;
  }
  const obj = raw as Record<string, unknown>;
  const seen = new Set<string>([HIDDEN_SECTION_ID]);
  const list = Array.isArray(obj.sections) ? obj.sections : [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = String(row.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.sections.push({ id, name: slugName(String(row.name ?? 'Section')) });
  }
  const collapsedRaw = Array.isArray(obj.collapsed) ? obj.collapsed : [HIDDEN_SECTION_ID];
  const knownSections = new Set(out.sections.map((s) => s.id));
  knownSections.add(HIDDEN_SECTION_ID);
  const collapsed: string[] = [];
  const seenCollapsed = new Set<string>();
  for (const id of collapsedRaw) {
    const sid = String(id || '');
    if (!knownSections.has(sid) || seenCollapsed.has(sid)) continue;
    seenCollapsed.add(sid);
    collapsed.push(sid);
  }
  if (!Array.isArray(obj.collapsed) && !seenCollapsed.has(HIDDEN_SECTION_ID)) collapsed.push(HIDDEN_SECTION_ID);
  out.collapsed = collapsed;
  const mem =
    obj.membership && typeof obj.membership === 'object' && !Array.isArray(obj.membership)
      ? (obj.membership as Record<string, unknown>)
      : {};
  const sectionIds = new Set(out.sections.map((s) => s.id));
  sectionIds.add(HIDDEN_SECTION_ID);
  for (const [agentId, sectionId] of Object.entries(mem)) {
    if (known.size && !known.has(agentId)) continue;
    const sid = String(sectionId || '');
    if (!sectionIds.has(sid)) continue;
    out.membership[agentId] = sid;
  }
  out.order = Array.isArray(obj.order) ? obj.order.map((x) => String(x)) : [];
  out.order = rebuildOrder(out, agentIds);
  return out;
}

export function sectionOf(layout: SidebarLayout, agentId: string): string | null {
  const s = layout.membership[agentId];
  if (!s) return null;
  if (s === HIDDEN_SECTION_ID) return s;
  if (layout.sections.some((x) => x.id === s)) return s;
  return null;
}

export type AgentLike = { id: string };

export type SidebarGroup<T extends AgentLike> = {
  key: string;
  id: string | null;
  name: string;
  hidden: boolean;
  agents: T[];
};

export function groupedAgents<T extends AgentLike>(agents: T[], layout: SidebarLayout): SidebarGroup<T>[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const bySec = new Map<string, T[]>();
  for (const s of layout.sections) bySec.set(s.id, []);
  const hidden: T[] = [];
  const loose: T[] = [];
  for (const a of agents) {
    const s = sectionOf(layout, a.id);
    if (s === HIDDEN_SECTION_ID) hidden.push(a);
    else if (s && bySec.has(s)) bySec.get(s)!.push(a);
    else loose.push(a);
  }
  const looseLeft = new Map(loose.map((a) => [a.id, a]));
  const groups: SidebarGroup<T>[] = [];
  let pending: T[] = [];
  const flushLoose = () => {
    if (!pending.length) return;
    groups.push({
      key: `u:${pending[0].id}`,
      id: null,
      name: '',
      hidden: false,
      agents: pending,
    });
    pending = [];
  };
  for (const id of rebuildOrder(layout, agents.map((a) => a.id))) {
    const sec = layout.sections.find((s) => s.id === id);
    if (sec) {
      flushLoose();
      groups.push({
        key: `s:${sec.id}`,
        id: sec.id,
        name: sec.name,
        hidden: false,
        agents: bySec.get(sec.id) || [],
      });
      continue;
    }
    const a = looseLeft.get(id) || byId.get(id);
    if (a && looseLeft.has(a.id)) {
      pending.push(a);
      looseLeft.delete(a.id);
    }
  }
  for (const a of loose) {
    if (looseLeft.has(a.id)) pending.push(a);
  }
  flushLoose();
  groups.push({
    key: `s:${HIDDEN_SECTION_ID}`,
    id: HIDDEN_SECTION_ID,
    name: HIDDEN_SECTION_NAME,
    hidden: true,
    agents: hidden,
  });
  return groups;
}

export function visualOrder<T extends AgentLike>(agents: T[], layout: SidebarLayout): string[] {
  return groupedAgents(agents, layout).flatMap((g) => g.agents.map((a) => a.id));
}

function withOrder(layout: SidebarLayout, agentIds: string[] = Object.keys(layout.membership)): SidebarLayout {
  return { ...layout, order: rebuildOrder(layout, agentIds) };
}

export function insertLane(layout: SidebarLayout, id: string, beforeId: string | null): SidebarLayout {
  if (id === HIDDEN_SECTION_ID || id === beforeId) return layout;
  const order = layout.order.filter((x) => x !== id);
  if (beforeId == null) order.unshift(id);
  else {
    const i = order.indexOf(beforeId);
    order.splice(i < 0 ? order.length : i, 0, id);
  }
  return { ...layout, order };
}

export function moveAgentToSection(
  layout: SidebarLayout,
  agentId: string,
  sectionId: string | null,
  agentIds: string[] = []
): SidebarLayout {
  const membership = { ...layout.membership };
  if (!sectionId) delete membership[agentId];
  else membership[agentId] = sectionId;
  let next: SidebarLayout = { ...layout, membership };
  if (sectionId) {
    next = { ...next, order: next.order.filter((x) => x !== agentId) };
  } else if (!next.order.includes(agentId)) {
    next = { ...next, order: [...next.order, agentId] };
  }
  return withOrder(next, agentIds.length ? agentIds : next.order);
}

export function createSection(layout: SidebarLayout, name: string, id: string, atAgentId?: string): SidebarLayout {
  const clean = slugName(name);
  if (id === HIDDEN_SECTION_ID || layout.sections.some((s) => s.id === id)) return layout;
  let next: SidebarLayout = {
    ...layout,
    sections: [...layout.sections, { id, name: clean }],
    collapsed: layout.collapsed.filter((x) => x !== id),
    order: layout.order.includes(id) ? layout.order : [...layout.order, id],
  };
  if (atAgentId) {
    next = insertLane(next, id, atAgentId);
    next = moveAgentToSection(next, atAgentId, id);
  }
  return next;
}

export function renameSection(layout: SidebarLayout, id: string, name: string): SidebarLayout {
  if (id === HIDDEN_SECTION_ID) return layout;
  return {
    ...layout,
    sections: layout.sections.map((s) => (s.id === id ? { ...s, name: slugName(name) } : s)),
  };
}

export function deleteSection(layout: SidebarLayout, id: string, agentIds: string[] = []): SidebarLayout {
  if (id === HIDDEN_SECTION_ID) return layout;
  const membership = { ...layout.membership };
  const freed: string[] = [];
  for (const [agentId, sectionId] of Object.entries(membership)) {
    if (sectionId === id) {
      delete membership[agentId];
      freed.push(agentId);
    }
  }
  const order = [...layout.order];
  const at = order.indexOf(id);
  if (at >= 0) order.splice(at, 1, ...freed);
  else order.push(...freed);
  return withOrder(
    {
      ...layout,
      sections: layout.sections.filter((s) => s.id !== id),
      membership,
      collapsed: layout.collapsed.filter((x) => x !== id),
      order,
    },
    agentIds
  );
}

export function toggleCollapsed(layout: SidebarLayout, id: string): SidebarLayout {
  if (id !== HIDDEN_SECTION_ID && !layout.sections.some((s) => s.id === id)) return layout;
  const on = layout.collapsed.includes(id);
  return { ...layout, collapsed: on ? layout.collapsed.filter((x) => x !== id) : [...layout.collapsed, id] };
}

/** Insert fromId before toId. toId may be a section or an unassigned agent. Hidden stays last. */
export function reorderSections(layout: SidebarLayout, fromId: string, toId: string | null): SidebarLayout {
  return insertLane(layout, fromId, toId);
}
