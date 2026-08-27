# hitl-policy conformance plan

This document is the traceability contract for allw#221's implementation. Tests are written first
from these IDs and retain the ID in the test name or fixture metadata. A fixture is complete only
when it checks both the returned value and the absence/presence of forbidden side effects.

## Package and bounded guards

| ID    | Requirement     | Expected assertion                                                                                                                                                                                   |
| ----- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-001 | JSON limits     | Depth 31 is accepted and depth 32 rejected according to the documented root-inclusive convention; 10,000 nodes/keys and 262,144 string code units are the accepted maxima, and one over is rejected. |
| G-002 | Safe data       | Cycles, accessors, functions, symbols, class instances, non-finite numbers, and non-ordinary prototypes are rejected without reading accessors; hostile proxies are an adapter precondition.         |
| G-003 | Text and IDs    | 256-code-unit IDs and 16,384-code-unit summary/rationale/display values pass; one over fails.                                                                                                        |
| G-004 | Runtime schemas | Schema version 1 is accepted; missing/unknown versions and discriminants fail closed on every exchanged envelope.                                                                                    |
| G-005 | Export boundary | `package.json` exports `.`, `./conformance`, and package metadata only; old L0–L3 paths are absent.                                                                                                  |
| G-006 | Portable build  | Built root and conformance declarations import without filesystem, network, crypto, native, or WASM dependencies in Node and a browser/worker-like runtime.                                          |
| G-007 | JS typecheck    | Root TypeScript checking includes and checks JavaScript configuration and release-script inputs rather than silently ignoring the included files.                                                    |

## Steel threads

| ID       | Requirement       | Expected assertion                                                                                                                                                                                          |
| -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GATE-001 | Policy-only allow | `createGate({ policy })` returns `state: "satisfied"` without a HITL capability or request.                                                                                                                 |
| GATE-002 | Policy-only deny  | Deny is `unsatisfied` and never prompts.                                                                                                                                                                    |
| GATE-003 | HITL-only         | Absent policy produces implicit ask and succeeds only after the implicit HITL request approves.                                                                                                             |
| GATE-004 | Missing HITL      | Absent policy plus absent HITL fails closed with `hitl-unavailable`.                                                                                                                                        |
| GATE-005 | Mixed terminal    | Mixed allow/deny never invokes HITL and maps to satisfied/unsatisfied respectively.                                                                                                                         |
| GATE-006 | Mixed ask         | Ask invokes HITL; approval may satisfy the gate but does not rewrite the retained policy result to allow.                                                                                                   |
| GATE-007 | Fresh deadline    | The gate re-reads its clock immediately before provider invocation while preserving the request's original timestamp, so work that expires during policy/change-offer callbacks never reaches the provider. |

## Reload and generation

| ID         | Requirement          | Expected assertion                                                                                                                 |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| RELOAD-001 | Synchronous creation | `createGate` performs no load I/O and exposes generation 0 immediately.                                                            |
| RELOAD-002 | Revision identity    | A changed loaded revision returns `updated` and increments generation; same revision returns `unchanged` and preserves generation. |
| RELOAD-003 | Last good snapshot   | Load rejection returns sanitized `failed`, emits diagnostics, and leaves the prior policy active.                                  |
| RELOAD-004 | Successful absence   | A loaded snapshot with undefined state replaces policy with implicit ask and increments generation when its revision changes.      |
| RELOAD-005 | Concurrent reload    | Concurrent `reload()` calls coalesce to one adapter load and the same result/generation.                                           |
| RELOAD-006 | Stale results        | `gate.isCurrent(result)` rejects a result from an older generation and accepts a current result.                                   |
| RELOAD-007 | Callback timeout     | Invalid per-call reload callback timeouts normalize to the bounded host default before invoking `policy.load`.                     |

## Failure normalization and assurance

| ID         | Requirement         | Expected assertion                                                                                                                                               |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FAIL-001   | Never reject        | Provider throw, rejection, unavailable provider, and malformed output resolve unsatisfied with sanitized failure categories.                                     |
| FAIL-002   | Hostile callbacks   | A throwing clock or accessor-backed provider registration settles fail-closed without invoking the provider, reading the accessor, or rejecting.                 |
| L0-004     | Deadline validation | Invalid, non-positive, non-integer, unsafe, or over-limit timeout, timestamp, or composed deadline returns timeout/invalid-request without calling the provider. |
| L0-008     | API version         | Unknown provider `apiVersion` is unavailable and is not called.                                                                                                  |
| L0-010     | Diagnostics         | Private provider exception text is absent from the returned result and reaches only the diagnostic sink.                                                         |
| L0-011     | Opaque evidence     | Evidence retains reference identity and is never parsed, cloned, stringified, or normalized.                                                                     |
| ASSURE-001 | Evidence gate       | Configured verification false/throw yields unsatisfied/evidence-failed.                                                                                          |
| ASSURE-002 | Audit gate          | Configured audit false/throw yields unsatisfied/audit-failed.                                                                                                    |

## Policy recheck

| ID          | Requirement     | Expected assertion                                                                                                                          |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| RECHECK-001 | Latest allow    | Approval followed by a current allow recheck satisfies the gate.                                                                            |
| RECHECK-002 | Latest deny     | Approval followed by current deny is unsatisfied/policy-changed.                                                                            |
| RECHECK-003 | Changed ask     | A changed approval key/requirement is policy-changed and never automatically re-prompts; provider mutation cannot rewrite the retained key. |
| RECHECK-004 | Instability cap | Three generation-change restarts followed by another change stop with policy-unstable.                                                      |

## Policy changes and editable drafts

| ID         | Requirement         | Expected assertion                                                                                                                                                                       |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHANGE-001 | Host choices        | Offers are requested, multiple selected choices are prepared, and all are atomically applied once.                                                                                       |
| CHANGE-002 | Namespaced edit     | An editable `{ namespace, kind, value }` draft is passed to prepare before application.                                                                                                  |
| CHANGE-003 | Negative decisions  | Rejection, timeout, and provider failure never prepare or apply changes.                                                                                                                 |
| CHANGE-004 | Independent failure | Malformed/unauthorized changes, including one malformed item in a mixed batch, leave the current one-shot result satisfied/unchanged and never apply.                                    |
| CHANGE-005 | Stale generation    | Changes selected against an old generation are discarded and not applied.                                                                                                                |
| CHANGE-006 | Future-only apply   | Accepted changes apply once, reload once, and never change the current result's retained policy decision.                                                                                |
| CHANGE-007 | Atomic preparation  | Any failed preparation discards the complete selected batch and never calls atomic apply.                                                                                                |
| CHANGE-008 | Reload independence | A failed reload after successful atomic apply does not change the already-computed one-shot result.                                                                                      |
| CHANGE-009 | Bounded batch       | At most 100 policy-change responses are retained, and the complete batch must fit the aggregate JSON boundary; an oversized batch is discarded without changing the one-shot decision.   |
| CHANGE-010 | Apply serialization | Snapshot generation cannot advance while the host atomic `apply` callback runs; a concurrent reload waits and then observes the applied policy instead of coalescing with stale loading. |

## Multi-authority and host boundaries

The suite must additionally prove that equal authority IDs coalesce only when approval keys/routes
agree, different authorities are conjunctive, missing/ambiguous routes fail closed, host policy
details do not cross the HITL request boundary, and the provider receives only bounded operation,
approval, and display data. Durable use counts, expiry, revocation, and native policy persistence
are adapter-owned tests because they are not implemented by this package.

## Issue traceability

The issue's package/export criteria map to `G-004..007`; L0 normalization to `L0-004`,
`L0-008`, `L0-010`, `L0-011`, and `FAIL-001..002`; policy-only/HITL/mixed behavior to `GATE-001..007`;
reload to `RELOAD-001..007`; assurance to `ASSURE-001..002`; policy re-evaluation to
`RECHECK-001..004`; and policy changes to `CHANGE-001..010`. The remaining issue documentation and
release criteria are checked by the package-boundary, built-portability, README, and release-policy
tests. No allw integration is required for core package conformance.
