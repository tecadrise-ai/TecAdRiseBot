import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDDEN_SECTION_ID,
  createSection,
  deleteSection,
  groupedAgents,
  insertLane,
  moveAgentToSection,
  normalizeLayout,
  reorderSections,
  toggleCollapsed,
  visualOrder,
} from './sidebarSections.ts';

test('hidden stays last and unassigned stays first by default', () => {
  const layout = normalizeLayout({
    sections: [
      { id: HIDDEN_SECTION_ID, name: 'nope' },
      { id: 'news', name: 'News' },
      { id: 'seo', name: 'SEO' },
    ],
    membership: { a: 'seo', b: HIDDEN_SECTION_ID, c: 'gone' },
  }, ['d', 'a', 'b', 'c']);
  const agents = [{ id: 'd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
  const groups = groupedAgents(agents, layout);
  assert.equal(groups[0].id, null);
  assert.deepEqual(groups[0].agents.map((x) => x.id), ['d', 'c']);
  assert.equal(groups[groups.length - 1].id, HIDDEN_SECTION_ID);
  assert.deepEqual(groups[groups.length - 1].agents.map((x) => x.id), ['b']);
  assert.deepEqual(visualOrder(agents, layout), ['d', 'c', 'a', 'b']);
});

test('create, move, reorder, delete section', () => {
  let layout = createSection({ sections: [], membership: {}, collapsed: [], order: [] }, 'Trading', 'tr');
  layout = moveAgentToSection(layout, 'x', 'tr', ['x']);
  layout = createSection(layout, 'Code', 'cd');
  layout = reorderSections(layout, 'cd', 'tr');
  assert.deepEqual(layout.sections.map((s) => s.id), ['tr', 'cd']);
  assert.ok(layout.order.indexOf('cd') < layout.order.indexOf('tr'));
  layout = reorderSections(layout, 'tr', null);
  assert.ok(layout.order.indexOf('tr') < layout.order.indexOf('cd'));
  layout = deleteSection(layout, 'tr', ['x']);
  assert.equal(layout.membership.x, undefined);
  assert.deepEqual(layout.sections.map((s) => s.id), ['cd']);
  layout = toggleCollapsed(layout, 'cd');
  assert.deepEqual(layout.collapsed, ['cd']);
});

test('section can sit between unassigned agents', () => {
  let layout = normalizeLayout(
    { sections: [{ id: 'web', name: 'Website' }], membership: {}, order: ['a', 'b', 'c'] },
    ['a', 'b', 'c']
  );
  layout = insertLane(layout, 'web', 'b');
  const groups = groupedAgents([{ id: 'a' }, { id: 'b' }, { id: 'c' }], layout);
  assert.deepEqual(groups.map((g) => [g.id, g.agents.map((x) => x.id)]), [
    [null, ['a']],
    ['web', []],
    [null, ['b', 'c']],
    [HIDDEN_SECTION_ID, []],
  ]);
});
