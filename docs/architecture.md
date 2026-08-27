# hitl-policy architecture

`hitl-policy` is one root integration surface with one optional conformance subpath. The public
API is intentionally a unified gate rather than independently imported L0–L3 packages.

## Runtime and module boundary

```text
src/
  index.ts          root-only production exports
  types.ts          documented public contracts and fixed limits
  guards.ts         bounded guards for all boundary values
  callbacks.ts      abortable deadline and failure normalization
  snapshots.ts      immutable policy state and coalesced reloads
  routing.ts        approval-key coalescing and provider invocation
  changes.ts        host policy-change preparation/apply boundary
  gate.ts           unified evaluation and recheck state machine
  conformance.ts    framework-neutral fixtures (published subpath)
```

`package.json` exports only `.`, `./conformance`, and package metadata. There must be no `./decision`, `./policy`,
`./escalation`, or `./suggestions` export. The root is the integration API; conformance helpers
are the sole additional public entrypoint.

Production code has zero runtime dependencies and uses only portable ECMAScript primitives and
`AbortSignal`. Valid gate inputs are copied into deeply frozen internal snapshots before host
callbacks run. It must run under Node, browser, and worker-like runtimes without filesystem,
network, crypto, native-binary, or WASM dependencies. Evidence, diagnostics, and host policy
state remain local opaque values and are not serialized by this package.

## State and reload ownership

`createGate` is synchronous and performs no I/O. A `PolicyAdapter` owns loading and exposes an
optional generation-0 `initial` snapshot plus an async `load`. `Gate.reload()` serializes concurrent
loads, installs only a validated complete snapshot, increments generation only when the host
revision changes, and preserves the last good snapshot after failure. `Gate.isCurrent(result)` uses
a private issued-generation registry rather than trusting mutable result fields.

An evaluation captures the current snapshot, runs policy, optionally requests human decisions,
and re-evaluates after approval using the same detached input. Matching authority/key/route
obligations may reuse the in-flight
approval across a generation change; new or changed obligations fail without re-prompting. It may
still race an external change after returning, so callers needing atomic execution must bind a
generation check to execution.

## Host-owned boundaries

The gate calls host-provided capabilities only:

```text
PolicyAdapter.evaluate/load
        |
        v
  policy result ---- ask ----> HitlCapability.request
        |                              |
        |                              +--> optional hitl.verify
        |                              +--> optional diagnostics
        v
  optional PolicyChangesCapability (prepare all, atomically apply, reload once)
        |
        v
  optional audit callback -> GateResult
```

The package does not provide policy syntax, routing infrastructure, human UI, transport,
cryptographic verification, a policy database, or execution. Multi-authority requirements are
conjoined by the gate; a host's `ApprovalRequirement` carries authority, approval key, route, and
layer provenance. Policy changes use host-authored choices or bounded namespaced JSON drafts and
never alter the current one-shot result.

## Tooling and release

Tests are written first from the IDs in [conformance.md](conformance.md). Standard checks include
format, lint, typecheck, declaration/package boundary, unit/conformance tests, and built-package
Node/browser import smoke tests. Changesets creates release pull requests; trusted npm publishing
is performed only by `release.yml` through the `npm-publish` GitHub environment and OIDC. The
project remains pre-1.0 until a deliberate release-policy check removes that status.
