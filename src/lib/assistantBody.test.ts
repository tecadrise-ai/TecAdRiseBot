import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeAssistantBody, packAssistantBody, THINK_CLOSE, THINK_OPEN, unpackAssistantBody } from './assistantBody.ts';

describe('assistantBody', () => {
  it('packs SDK thinking in host markers and unpacks them', () => {
    const packed = packAssistantBody('plan the step', 'Here is the result.');
    assert.match(packed, new RegExp(`${THINK_OPEN}[\\s\\S]*plan the step[\\s\\S]*${THINK_CLOSE}`));
    assert.match(packed, /Here is the result\./);
    assert.deepEqual(unpackAssistantBody(packed), { thinking: 'plan the step', answer: 'Here is the result.' });
  });

  it('treats unmarked text as the answer', () => {
    assert.deepEqual(unpackAssistantBody('Just a reply.'), { thinking: '', answer: 'Just a reply.' });
  });

  it('does not move English plan phrasing out of the answer', () => {
    const text = finalizeAssistantBody('', "I'll check the logs.\n\nThe service is up.");
    assert.equal(unpackAssistantBody(text).answer, "I'll check the logs.\n\nThe service is up.");
    assert.equal(unpackAssistantBody(text).thinking, '');
  });
});
