# hitl-policy decisions

This log records decisions for the unified gate. Integration-specific behavior belongs under
`docs/integrations/` and cannot silently change the portable contract.

## D1 — Unified root gate

**Decision:** Expose `createGate` at the package root and `hitl-policy/conformance` only. Remove
independently consumable L0–L3 production subpaths.

**Reason:** Consumers need one consistent lifecycle for policy, HITL, reload, assurance, and
execution gating. A single surface also makes the policy-recheck and stale-generation rules
observable and testable.

## D2 — Host-defined policy adapters

**Decision:** A policy adapter owns native policy state and returns terminal `allow`, `deny`, or
`ask` evaluations. A successful absent snapshot means policy absence and implicit ask.

**Reason:** The package must not invent a selector or capability language. Host revisions let the
gate identify a loaded snapshot without interpreting its state.

## D3 — Synchronous creation, adapter-owned reload

**Decision:** `createGate` performs no I/O. `PolicyAdapter.load` is called by `gate.reload`, and
concurrent reload calls coalesce onto one load.

**Reason:** Loading policy is host I/O and should not surprise callers during construction. Atomic
replacement and a last-good snapshot provide predictable failure behavior.

## D4 — Revision and generation

**Decision:** Generation starts at zero and increments exactly once when a successful reload changes
policy presence or the host revision. Same-presence, same-revision reload is `unchanged`; failures
preserve the old generation. `isCurrent` rejects stale results using a private gate-issued generation
record, so caller mutation of a result cannot revive it.

**Reason:** Revisions represent host policy identity; generation provides cheap in-process staleness
checks even when an adapter has no globally comparable revision ordering.

## D5 — Implicit and multi-authority ask

**Decision:** No policy creates one ask from `hitl.implicitRequirement`. Explicit ask requirements
are grouped only when authority and approval key agree and routes agree; different authorities are
conjunctive.

**Reason:** A human response is never a universal authorization, and one authority must not
accidentally satisfy another authority's obligation.

## D6 — Recheck after approval

**Decision:** After an approved HITL result, current policy is re-evaluated. Latest allow satisfies,
latest deny blocks, and latest ask may reuse only matching authority/key/route obligations. Removed
obligations are harmless; new or changed obligations return `policy-changed` without automatic
re-prompting. Three generation-change restarts are allowed before `policy-unstable`.

**Reason:** Human deliberation takes time. The current policy, not the policy that prompted, governs
the operation and any selected policy change.

## D7 — Optional assurance gates

**Decision:** Evidence verification and durable audit callbacks are optional neutral gates. Once
configured, failure is mandatory denial.

**Reason:** Local providers may have no artifact, while cryptographic or durable hosts require
stronger assurance. The portable package must not pretend to verify opaque evidence.

## D8 — Policy changes are host-applied and future-only

**Decision:** Approved responses may carry host-authored choices or editable namespaced JSON drafts.
The host prepares all changes, atomically applies them, and reloads once. Invalid, unauthorized,
partial, or stale changes never affect the current result and only accepted changes affect later
evaluations.

**Reason:** Policy mutation, persistence, and audit are host authorities. A one-shot decision must
not become a standing bearer grant.

## D9 — Residual post-result race is explicit

**Decision:** The gate checks generation before returning but does not claim a transaction lock.
Hosts must re-check or commit generation with execution when strict atomicity is required.

**Reason:** No in-process API can prevent an independent external policy change after it returns a
result and before a caller executes an operation.

## D10 — Concrete bounded validation and pre-1.0 release

**Decision:** Use fixed JSON, identifier, text, timeout, and timer limits in the specification;
remain pre-1.0 until a deliberate release-policy check changes status. Changesets and OIDC are
the release path.

**Reason:** “Bounded” and “stable” must be reproducible claims, not implementation guesses.
