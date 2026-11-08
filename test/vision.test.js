import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDataUrl, findImageFileInText, enrichInputWithVision } from '../src/vision.js';

describe('vision module', () => {
  test('parseDataUrl correctly parses valid image data URLs', () => {
    const valid = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const parsed = parseDataUrl(valid);
    assert.ok(parsed);
    assert.equal(parsed.mimeType, 'image/png');
    assert.equal(Buffer.isBuffer(parsed.buffer), true);
    assert.equal(parsed.buffer.length, 68);
  });

  test('parseDataUrl returns null for non-data URLs', () => {
    assert.equal(parseDataUrl('https://example.com/pic.png'), null);
    assert.equal(parseDataUrl(''), null);
    assert.equal(parseDataUrl(null), null);
  });

  test('findImageFileInText finds existing image files and ignores missing ones', () => {
    assert.equal(findImageFileInText('Please see /tmp/non_existent_image_123.png'), null);
    assert.equal(findImageFileInText('No images here'), null);
  });

  test('enrichInputWithVision leaves text-only input untouched', async () => {
    const input = [
      { role: 'user', content: 'Hello, how are you?' }
    ];
    const enriched = await enrichInputWithVision({ input, token: 'mock-token' });
    assert.equal(enriched[0].content, 'Hello, how are you?');
  });

  test('enrichInputWithVision handles empty or non-array inputs gracefully', async () => {
    assert.deepEqual(await enrichInputWithVision({ input: [], token: 'tok' }), []);
    assert.equal(await enrichInputWithVision({ input: null, token: 'tok' }), null);
    assert.equal(await enrichInputWithVision({ input: undefined, token: 'tok' }), undefined);
  });
});
