import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
  name?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
};
const tsconfig = JSON.parse(readFileSync(join(projectRoot, 'tsconfig.json'), 'utf8')) as {
  compilerOptions?: { allowJs?: boolean; checkJs?: boolean };
};

describe('G-005 package boundary', () => {
  it('publishes one root integration surface and the conformance subpath', () => {
    expect(packageJson.name).toBe('hitl-policy');
    expect(packageJson.exports).toEqual({
      '.': expect.anything(),
      './conformance': expect.anything(),
      './package.json': './package.json',
    });
  });

  it('has no old L0-L3 production subpaths or rootless leaf entrypoints', () => {
    expect(packageJson.exports).not.toHaveProperty('./decision');
    expect(packageJson.exports).not.toHaveProperty('./policy');
    expect(packageJson.exports).not.toHaveProperty('./escalation');
    expect(packageJson.exports).not.toHaveProperty('./suggestions');
  });

  it('G-006 declares zero production runtime dependencies', () => {
    expect(packageJson.dependencies ?? {}).toEqual({});
  });

  it('G-006 has built root and conformance declarations without a root native dependency', () => {
    const dist = join(projectRoot, 'dist');
    if (!existsSync(dist)) return;
    expect(existsSync(join(dist, 'index.js'))).toBe(true);
    expect(existsSync(join(dist, 'index.d.ts'))).toBe(true);
    expect(existsSync(join(dist, 'conformance.js'))).toBe(true);
    expect(existsSync(join(dist, 'conformance.d.ts'))).toBe(true);
    const declaration = readFileSync(join(dist, 'index.d.ts'), 'utf8');
    expect(declaration).not.toMatch(/node:fs|node:crypto|allw-core|\.wasm/);
  });

  it('G-006 keeps built runtime entrypoints portable and importable', async () => {
    const dist = join(projectRoot, 'dist');
    if (!existsSync(dist)) return;
    for (const entry of ['index.js', 'conformance.js']) {
      const source = readFileSync(join(dist, entry), 'utf8');
      expect(source).not.toMatch(/from ['"]node:|require\(|\.node['"]|\.wasm['"]/);
      await expect(import(join(dist, entry))).resolves.toBeTypeOf('object');
    }
  });

  it('G-007 typechecks included JavaScript configuration and release scripts', () => {
    expect(tsconfig.compilerOptions).toMatchObject({ allowJs: true, checkJs: true });
  });
});
