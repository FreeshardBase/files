import { describe, expect, it } from 'vitest';
import { dbPath, homeRoot } from '../src/paths.ts';

describe('data root layout', () => {
  it('keeps the database at DATA_DIR/files.db', () => {
    expect(dbPath('/data')).toBe('/data/files.db');
  });
  it('keeps each home at DATA_DIR/homes/<userId>', () => {
    expect(homeRoot('/data', 'u1')).toBe('/data/homes/u1');
  });
});
