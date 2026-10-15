import { describe, expect, it } from 'vitest';
import { previewKind } from '../src/preview.ts';

describe('previewKind', () => {
  it.each([
    ['image/png', 'image'], ['image/jpeg', 'image'], ['image/gif', 'image'], ['image/webp', 'image'], ['image/avif', 'image'],
    ['video/mp4', 'video'], ['video/webm', 'video'], ['audio/mpeg', 'audio'], ['audio/wav', 'audio'],
    ['application/pdf', 'pdf'], ['text/markdown', 'markdown'], ['text/plain', 'text'], ['text/csv', 'text'],
    ['application/json', 'text'], ['application/xml', 'text'], ['text/html', 'text'],
    // Never rendered: SVG can carry script, HEIC does not decode in browsers, everything else is unknown.
    ['image/svg+xml', 'none'], ['image/heic', 'none'], ['application/zip', 'none'], ['application/octet-stream', 'none'], [undefined, 'none'],
  ])('%s → %s', (mime, kind) => {
    expect(previewKind(mime)).toBe(kind);
  });
});
