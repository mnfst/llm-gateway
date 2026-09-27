import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from './data-source-definitions';

describe('migration registry', () => {
  it('registers every source migration exactly once', () => {
    const sourceNames = readdirSync(join(__dirname, 'migrations'))
      .filter((file) => /^\d+-.+\.ts$/.test(file) && !file.endsWith('.spec.ts'))
      .map((file) => {
        const [, timestamp, description] = file.match(/^(\d+)-(.+)\.ts$/)!;
        return `${description}${timestamp}`;
      })
      .sort();
    const registeredNames = migrations.map((Migration) => Migration.name).sort();

    expect(registeredNames).toEqual(sourceNames);
  });
});
