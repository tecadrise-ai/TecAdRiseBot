import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteChatImageSrc, rewriteMarkdownImages } from './rewriteChatImages.ts';

const opts = {
  agentId: 'agt1',
  userDataPath: 'C:\\Users\\AppUser\\AppData\\Roaming\\TecAdRiseBot',
};

test('https images go through tecimg proxy', () => {
  const src = rewriteChatImageSrc('https://lh3.googleusercontent.com/a/photo.jpg', opts);
  assert.equal(src.startsWith('tecimg://h/?u='), true);
  assert.ok(src.includes(encodeURIComponent('https://lh3.googleusercontent.com/a/photo.jpg')));
});

test('workspace relative path uses w/agentId', () => {
  assert.equal(
    rewriteChatImageSrc('photos/board.jpg', opts),
    'tecimg://u/w/agt1/photos/board.jpg'
  );
});

test('absolute path under userData becomes tecimg file url', () => {
  assert.equal(
    rewriteChatImageSrc('C:\\Users\\AppUser\\AppData\\Roaming\\TecAdRiseBot\\w\\agt1\\generated\\x.png', opts),
    'tecimg://u/w/agt1/generated/x.png'
  );
});

test('path outside userData is left alone', () => {
  const src = 'C:\\Windows\\wallpaper.jpg';
  assert.equal(rewriteChatImageSrc(src, opts), src);
});

test('markdown images rewrite, code fences do not', () => {
  const md = [
    'See ![board](photos/a.jpg)',
    '',
    '```',
    '![no](https://example.com/x.png)',
    '```',
    '',
    '<img src="https://cdn.example/b.jpg">',
  ].join('\n');
  const out = rewriteMarkdownImages(md, opts);
  assert.ok(out.includes('tecimg://u/w/agt1/photos/a.jpg'));
  assert.ok(out.includes('tecimg://h/?u='));
  assert.ok(out.includes('```\n![no](https://example.com/x.png)\n```'));
});

test('dot-dot relative paths are not rewritten', () => {
  assert.equal(rewriteChatImageSrc('../secret.png', opts), '../secret.png');
});
