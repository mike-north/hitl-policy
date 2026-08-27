import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads a checked-in JSON file so the scaffold contract is tested as users receive it. */
function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), 'utf8'));
}

describe('project scaffold', () => {
  it('defines the supported Node and pnpm toolchain', () => {
    expect(readJson('package.json')).toMatchObject({
      name: 'hitl-policy',
      type: 'module',
      engines: { node: '>=24' },
      packageManager: 'pnpm@11.12.0',
    });
  });

  it('provides the mandatory build, check, and test entrypoints', () => {
    expect(readJson('package.json')).toMatchObject({
      scripts: {
        build: expect.any(String),
        check: expect.any(String),
        test: expect.any(String),
      },
    });
  });

  it('keeps the TypeScript library strict and emit-safe', () => {
    expect(readJson('tsconfig.json')).toMatchObject({
      compilerOptions: {
        strict: true,
        noEmitOnError: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
      },
    });
  });

  it('publishes only the root API, conformance fixtures, and manifest', () => {
    expect(readJson('package.json')).toMatchObject({
      exports: {
        '.': expect.any(Object),
        './conformance': expect.any(Object),
        './package.json': './package.json',
      },
    });
  });
});
