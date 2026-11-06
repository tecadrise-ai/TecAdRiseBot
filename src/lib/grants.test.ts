import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectorMcpName, parseGrants, pickGrantedServers } from './grants.ts';

describe('parseGrants', () => {
  it('defaults missing grants to none', () => {
    assert.deepEqual(parseGrants(null), { mcp: [], connectors: [] });
    assert.deepEqual(parseGrants({}), { mcp: [], connectors: [] });
  });

  it('reads unique names', () => {
    assert.deepEqual(
      parseGrants({ grants: { mcp: ['playwright', 'playwright', ''], connectors: ['github'] } }),
      { mcp: ['playwright'], connectors: ['github'] }
    );
  });
});

describe('pickGrantedServers', () => {
  it('attaches catalog + connectors only when granted; extra always', () => {
    const picked = pickGrantedServers(
      { playwright: { command: 'npx' }, other: { command: 'x' } },
      { github: { url: 'http://g' }, zoho_mail: { url: 'http://z' } },
      { workflow: { url: 'http://w' } },
      { mcp: ['playwright'], connectors: ['github', 'zoho'] }
    );
    assert.deepEqual(Object.keys(picked).sort(), ['github', 'playwright', 'workflow', 'zoho_mail']);
  });

  it('attaches nothing from catalog or connectors when grants are empty', () => {
    const picked = pickGrantedServers(
      { playwright: { command: 'npx' } },
      { github: { url: 'http://g' } },
      {},
      { mcp: [], connectors: [] }
    );
    assert.deepEqual(picked, {});
  });
});

describe('connectorMcpName', () => {
  it('maps zoho to zoho_mail', () => {
    assert.equal(connectorMcpName('zoho'), 'zoho_mail');
    assert.equal(connectorMcpName('github'), 'github');
  });
});
