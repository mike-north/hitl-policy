// The declaration bundler removes the source entrypoint's leading TSDoc block.
// Restore it on bundled declarations so API Extractor and editors retain the
// package-level contract instead of reporting an undocumented package.
const packageDocumentation = `/**
 * @packageDocumentation
 *
 * Creates the single policy-only, HITL-only, or mixed integration surface.
 */`;

// Keep each public concept as an independently importable entrypoint.
export default {
  entry: ['src/index.ts', 'src/conformance.ts'],
  format: ['esm'],
  dts: { banner: packageDocumentation },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
} as const;
