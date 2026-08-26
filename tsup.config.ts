// Keep each public concept as an independently importable entrypoint.
export default {
  entry: ['src/index.ts', 'src/conformance.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
} as const;
