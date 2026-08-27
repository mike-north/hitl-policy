import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseCheck = join(projectRoot, 'scripts/check-release-policy.mjs');
const testRoot = mkdtempSync(join(tmpdir(), 'hitl-policy-release-'));

afterAll(() => {
  // The directory is created by this test with a unique, validated prefix.
  rmSync(testRoot, { force: true, recursive: true });
});

/** Runs the release check with Node and captures its public command-line result. */
function runReleaseCheck(scriptPath: string) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
  });
}

describe('pre-1.0 release policy', () => {
  it('accepts the repository package while its version is below 1.0', () => {
    const result = runReleaseCheck(releaseCheck);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('is pre-1.0');
  });

  it('rejects a package at 1.0.0', () => {
    const fixtureRoot = join(testRoot, 'major-version');
    const fixtureScripts = join(fixtureRoot, 'scripts');

    // Keep the fixture identical to the shipped check while changing only the
    // package metadata that represents an accidental stable release.
    mkdirSync(fixtureScripts, { recursive: true });
    writeFileSync(join(fixtureScripts, 'check-release-policy.mjs'), readFileSync(releaseCheck));
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: 'hitl-policy', version: '1.0.0' }),
    );

    const result = runReleaseCheck(join(fixtureScripts, 'check-release-policy.mjs'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must remain below 1.0.0');
  });
});
