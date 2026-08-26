# allw integration note

This document is non-normative. It describes a possible allw adapter for `hitl-policy`; allw is
not a dependency of the core package and this note does not change the gate contract.

## HITL adapter

An adapter can implement `HitlAdapter` by translating an `ApprovalDecisionRequest` into the exact
allw approval request. Only a fully verified, request-bound allw verdict maps
to `DecisionResult.decision.state: "approved"`. Denied/aborted verdicts map to `rejected`, expired
verdicts to `timeout`, and SDK/provider failures to normalized failure categories.

Signed verdict bytes remain in the local opaque `evidence` field. The generic package does not
verify, parse, normalize, serialize, or re-sign them. The adapter or host must perform identity,
expiry, request binding, revocation, and durable-audit checks before an approval can satisfy the
gate.

## Host policy and changes

Allw policy state is owned by a `PolicyAdapter` and exposed through its host revision/state
snapshot. An allw-specific policy-change capability may offer host-authored choices or prepare an
editable namespaced JSON draft. It must validate, authorize, persist, audit, and reload accepted
changes through the ordinary policy path. A one-shot verdict must never become standing-policy
authority, and accepted changes affect only later evaluations.

## Exact binding and failure boundary

The adapter must remain unavailable or fail closed when it cannot obtain the exact operation the
host will execute. A sanitized summary cannot substitute for exact request binding or be described
as an equivalent verified human view. Missing evidence, malformed/revoked evidence, audit failure,
stale generation, and current-policy recheck failure all leave the gate unsatisfied.

Adapter-owned tests should cover verdict/request/caller binding, expiry, diagnostic redaction,
separate policy-change handling, durable audit, reload generation checks, and the residual race
between returning a gate result and executing the operation. The core package remains installable
and testable without an allw checkout, SDK, cryptographic implementation, native binary, or WASM
module.
