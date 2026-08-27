import { readFile } from 'node:fs/promises';

// This library intentionally stays pre-1.0 until its public policy contract is stable.
// A major release at or above 1 would bypass that governance decision.
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const major = Number.parseInt(packageJson.version.split('.')[0] ?? '', 10);

if (!Number.isInteger(major) || major >= 1) {
  console.error(
    `Release policy violation: ${packageJson.name}@${packageJson.version} must remain below 1.0.0.`,
  );
  process.exit(1);
}

console.log(`Release policy OK: ${packageJson.name}@${packageJson.version} is pre-1.0.`);
