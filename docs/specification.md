# hitl-policy specification

**Status:** proposed public contract, version 0.1. This is the normative specification for the
unified reloadable `createGate` API and the implementation acceptance criteria in allw#221. The
package is provider-neutral; host policy syntax and provider transport remain host-owned.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative in the sense
of RFC 2119. Requirement IDs map to [conformance.md](conformance.md).

## 1. Purpose and safety model

`hitl-policy` combines an optional policy adapter, an optional human-decision adapter, and optional
assurance and policy-change adapters behind one root API:

```text
gate.evaluate(input) -> GateResult
```

`GateResult.state` describes only the policy/HITL gate. A caller MUST still combine a satisfied
result with ambient authority and operation-specific gates. A human approval is one-shot and bound
to the exact request; it is not a reusable bearer grant. Policy changes affect future evaluations.

| Configuration     | Behavior                                                             |
| ----------------- | -------------------------------------------------------------------- |
| `policy` only     | `allow` is satisfied; `deny` and `ask` without HITL are unsatisfied. |
| `hitl` only       | No policy creates one implicit ask from `implicitRequirement`.       |
| `policy` + `hitl` | Allow/deny never prompt; ask requires every distinct authority.      |
| `policy.load`     | `reload()` loads and atomically installs a complete policy snapshot. |

The package does not define a universal operation, identity, risk, selector, capability, policy,
transport, cryptographic, persistence, audit, UI, or routing language. It does not execute an
operation, verify opaque evidence, or apply a policy change.

## 2. Public surface

The root exports `createGate`, the types below, guards, and `invokeDecision`. The only secondary
entrypoint is `hitl-policy/conformance`. There are no old `/decision`, `/policy`, `/escalation`, or
`/suggestions` exports.

### 2.1 Bounded values

```ts
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CallerIdentity {
  readonly kind: string;
  readonly id: string;
  readonly displayName?: string;
}

export interface GateInput<TOperation extends JsonValue = JsonValue> {
  readonly id?: string;
  readonly operationId: string;
  readonly operation: TOperation;
  readonly caller: CallerIdentity;
  readonly riskClass?: string;
  readonly summary?: string;
  readonly requestedAtMs?: number;
  readonly timeoutMs?: number;
}

export interface DecisionRequest<TOperation extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly operationId: string;
  readonly operation: TOperation;
  readonly caller: CallerIdentity;
  readonly riskClass?: string;
  readonly summary: string;
  readonly requestedAtMs: number;
  readonly timeoutMs: number;
}
export interface ApprovalDecisionRequest<
  TOperation extends JsonValue = JsonValue,
> extends DecisionRequest<TOperation> {
  readonly approval: ApprovalRequirement;
  readonly policyChange?: PolicyChangeRequest;
}

export const LIMITS: {
  readonly maxJsonDepth: 32;
  readonly maxJsonNodes: 10_000;
  readonly maxObjectKeys: 10_000;
  readonly maxStringCodeUnits: 262_144;
  readonly maxIdentifierCodeUnits: 256;
  readonly maxDisplayCodeUnits: 16_384;
  readonly maxHumanTimeoutMs: 86_400_000;
  readonly maxHostCallbackTimeoutMs: 60_000;
  readonly maxTimerMs: 2_147_483_647;
};

export function isJsonValue(value: unknown): value is JsonValue;
export function isCallerIdentity(value: unknown): value is CallerIdentity;
export function isDecisionRequest(value: unknown): value is DecisionRequest;
```

Guards MUST reject cycles, accessors, functions, symbols, class instances, non-ordinary
prototypes, non-finite numbers, unknown versions/discriminants, and over-limit values without
reading accessors. Container depth is root-inclusive; the outer value does not consume the
10,000-descendant node budget. ECMAScript exposes no portable, trap-free way to distinguish a
transparent `Proxy` from its target, so an adapter accepting hostile proxies MUST reject them
before this portable boundary.
IDs are non-empty and at most 256 UTF-16 code units. Summary, rationale, and display text are at
most 16,384 code units. Evidence, policy state, and details are local opaque values and MUST NOT
be serialized, parsed, cloned, stringified, redacted, or verified by this package.

### 2.2 Policy adapter

```ts
export interface ApprovalRequirement {
  readonly authorityId: string;
  readonly approvalKey: string;
  readonly routeId?: string;
}

export interface TerminalPolicyEvaluation {
  readonly decision: 'allow' | 'deny';
  readonly source: 'directive' | 'default';
  readonly reason?: string;
  readonly details?: unknown;
}

export interface AskPolicyEvaluation {
  readonly decision: 'ask';
  readonly requirements: readonly [ApprovalRequirement, ...ApprovalRequirement[]];
  readonly reason?: string;
  readonly details?: unknown;
}

export type PolicyEvaluation = TerminalPolicyEvaluation | AskPolicyEvaluation;

export interface PolicyState<TPolicy = unknown> {
  readonly revision: string;
  readonly state: TPolicy;
}
export interface AbsentPolicyState {
  readonly revision: string;
  readonly state?: undefined;
}
export type LoadedPolicyState<TPolicy = unknown> = PolicyState<TPolicy> | AbsentPolicyState;

export interface PolicyAdapter<TInput = unknown, TPolicy = unknown> {
  readonly apiVersion?: 1;
  readonly initial?: LoadedPolicyState<TPolicy>;
  readonly load?: (context: {
    readonly signal: AbortSignal;
    readonly generation: number;
  }) => Promise<LoadedPolicyState<TPolicy>>;
  evaluate(
    input: TInput,
    context: {
      readonly signal: AbortSignal;
      readonly generation: number;
      readonly revision?: string;
      readonly state: TPolicy;
    },
  ): PolicyEvaluation | Promise<PolicyEvaluation>;
}

export function isPolicyEvaluation(value: unknown): value is PolicyEvaluation;
export function isPolicyAdapter(value: unknown): value is PolicyAdapter;
```

The adapter owns the policy language and state validation. An absent loaded state is successful
policy absence and becomes implicit ask. Adapter failure, timeout, cancellation, unavailability,
or malformed output becomes `policy-error`. Policy details never cross the HITL request boundary.

### 2.3 Human decision adapter

```ts
export type DecisionFailure =
  | 'invalid-request'
  | 'provider-error'
  | 'provider-unavailable'
  | 'malformed-result'
  | 'caller-aborted'
  | 'deadline-exceeded';
export type DecisionOutcome =
  | { readonly state: 'approved'; readonly reason?: string; readonly failure?: never }
  | { readonly state: 'rejected'; readonly reason?: string; readonly failure?: DecisionFailure }
  | {
      readonly state: 'timeout';
      readonly reason?: string;
      readonly failure?: 'invalid-request' | 'deadline-exceeded';
    };
export interface DecisionResult {
  readonly schemaVersion: 1;
  readonly decision: DecisionOutcome;
  readonly evidence?: unknown;
  readonly policyChanges?: readonly PolicyChangeResponse[];
}
export interface DecisionProvider<TOperation extends JsonValue = JsonValue> {
  readonly apiVersion: 1;
  readonly providerId: string;
  request(
    request: ApprovalDecisionRequest<TOperation>,
    context: { readonly signal: AbortSignal },
  ): Promise<DecisionResult>;
}
export type DecisionRoute<TOperation extends JsonValue = JsonValue> =
  | DecisionProvider<TOperation>
  | {
      readonly providerId?: string;
      request(
        request: ApprovalDecisionRequest<TOperation>,
        context: { readonly signal: AbortSignal },
      ): Promise<DecisionResult>;
    };
export interface HitlAdapter<TOperation extends JsonValue = JsonValue> {
  readonly implicitRequirement: ApprovalRequirement;
  readonly providerId?: string;
  request(
    request: ApprovalDecisionRequest<TOperation>,
    context: { readonly signal: AbortSignal },
  ): Promise<DecisionResult>;
  route?(requirement: ApprovalRequirement): DecisionRoute<TOperation> | undefined;
  verify?(result: DecisionResult, request: ApprovalDecisionRequest): boolean | Promise<boolean>;
}
export interface DecisionInvocationOptions {
  readonly signal?: AbortSignal;
  readonly nowMs?: () => number;
  readonly diagnostics?: DiagnosticReporter;
}
export function isDecisionResult(value: unknown): value is DecisionResult;
export function invokeDecision(
  provider: DecisionProvider | undefined,
  request: unknown,
  options?: DecisionInvocationOptions,
): Promise<DecisionResult>;
```

`invokeDecision` validates before invocation, rejects strictly future/unsafe timestamps and
invalid deadlines without invocation, composes abort signals, resolves exactly once, ignores late
results, clears timers, and never rejects for controlled provider failures. Exceptions go only to
the diagnostic sink. Approved cannot carry a failure; explicit rejection remains distinguishable
from provider/channel failure. A configured `verify` callback is a mandatory negative gate.
Gate-created provider requests are detached, deeply frozen snapshots, so provider code cannot
rewrite the operation or approval key retained for policy recheck, evidence verification, or audit.
Accepted timestamps leave enough safe-integer headroom for the maximum human timeout, so every
validated request also has a representable deadline.
Clock exceptions and accessor-backed provider registration fields normalize fail-closed without
invocation; provider IDs and request methods are captured once before untrusted code runs. A
`request` method may be an own data property or a normal prototype-defined class method; prototype
accessors are never invoked.

### 2.4 Policy changes and gate

```ts
export interface PolicyChangeOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}
export interface PolicyDraft {
  readonly namespace: string;
  readonly kind: string;
  readonly value: JsonValue;
  readonly display?: string;
}
export interface PolicyChangeRequest {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly options?: readonly PolicyChangeOption[];
  readonly draft?: PolicyDraft;
}
export type PolicyChangeResponse =
  | { readonly schemaVersion: 1; readonly type: 'choice'; readonly optionId: string }
  | { readonly schemaVersion: 1; readonly type: 'edit'; readonly draft: PolicyDraft };
export interface PolicyChangeAdapter<TInput = unknown, TModification = unknown> {
  readonly apiVersion?: 1;
  offers?(context: {
    readonly signal: AbortSignal;
    readonly input: TInput;
    readonly generation: number;
    readonly revision?: string;
  }):
    | PolicyChangeOffer
    | readonly PolicyChangeOption[]
    | Promise<PolicyChangeOffer | readonly PolicyChangeOption[]>;
  prepare(
    change: PolicyChangeResponse,
    context: {
      readonly signal: AbortSignal;
      readonly input: TInput;
      readonly generation: number;
      readonly revision?: string;
    },
  ): TModification | Promise<TModification>;
  apply(
    modifications: readonly TModification[],
    context: {
      readonly signal: AbortSignal;
      readonly input: TInput;
      readonly generation: number;
      readonly revision?: string;
    },
  ): boolean | void | Promise<boolean | void>;
}
export interface PolicyChangeOffer {
  readonly options?: readonly PolicyChangeOption[];
  readonly draft?: PolicyDraft;
}

export type GateFailure =
  | 'invalid-input'
  | 'policy-denied'
  | 'policy-error'
  | 'hitl-unavailable'
  | 'route-conflict'
  | 'route-unavailable'
  | 'decision-rejected'
  | 'decision-timeout'
  | 'decision-error'
  | 'malformed-decision'
  | 'caller-aborted'
  | 'evidence-failed'
  | 'audit-failed'
  | 'policy-changed'
  | 'policy-unstable';
export type PolicyResolution =
  | (TerminalPolicyEvaluation & { readonly generation: number; readonly revision?: string })
  | (AskPolicyEvaluation & {
      readonly source: 'directive' | 'implicit';
      readonly generation: number;
      readonly revision?: string;
    });
export interface HumanDecisionRecord {
  readonly requirement: ApprovalRequirement;
  readonly request: DecisionRequest;
  readonly result: DecisionResult;
}
export interface HumanResolution {
  readonly decisions: readonly HumanDecisionRecord[];
}
export type GateResult<TOperation extends JsonValue = JsonValue> =
  | {
      readonly state: 'satisfied';
      readonly input: GateInput<TOperation>;
      readonly generation: number;
      readonly revision?: string;
      readonly policy: PolicyResolution;
      readonly human?: HumanResolution;
    }
  | {
      readonly state: 'unsatisfied';
      readonly failure: GateFailure;
      readonly input: GateInput<TOperation>;
      readonly generation: number;
      readonly revision?: string;
      readonly policy: PolicyResolution;
      readonly human?: HumanResolution;
    };
export interface GateConfig<
  TOperation extends JsonValue = JsonValue,
  TPolicy = unknown,
  TModification = unknown,
> {
  readonly policy?: PolicyAdapter<GateInput<TOperation>, TPolicy>;
  readonly hitl?: HitlAdapter<TOperation>;
  readonly policyChanges?: PolicyChangeAdapter<GateInput<TOperation>, TModification>;
  readonly audit?: (event: {
    readonly input: GateInput<TOperation>;
    readonly generation: number;
    readonly revision?: string;
    readonly policy: PolicyResolution;
    readonly human?: HumanResolution;
  }) => boolean | Promise<boolean>;
  readonly diagnostics?: DiagnosticReporter;
  readonly nowMs?: () => number;
  readonly defaultTimeoutMs?: number;
  readonly callbackTimeoutMs?: number;
}
export function createGate<TOperation extends JsonValue = JsonValue>(
  config: GateConfig<TOperation>,
): Gate<TOperation>;
```

`state: "satisfied"` is a positive result only after policy, every required HITL decision,
configured evidence, configured audit, and current-generation checks pass. It is not authorization.
Policy changes are prepared and applied atomically by the host; malformed or unauthorized changes
leave the current result unchanged and never activate partial policy. If any response in a selected
change batch is malformed or any preparation fails, the entire optional batch is discarded.

## 3. Evaluation state machine

1. `createGate` is synchronous and performs no load I/O. It installs `policy.initial` at generation
   zero, or starts in implicit ask when no policy is present.
2. `evaluate` validates, detaches, and deeply freezes the complete caller input before any host
   callback or suspension. It then fills omitted request ID/time/timeout, rejects future timestamps,
   and captures the current revision/generation. Invalid input invokes no adapter. Every later
   callback and `result.input` receives the detached snapshot, so caller mutation cannot change the
   operation after policy or human review.
3. A policy allow or deny is terminal and never invokes HITL. Policy absence creates the implicit
   requirement. Policy ask uses its non-empty requirements.
4. Requirements with equal authority, approval key, and compatible route coalesce. Different
   authorities remain conjunctive. Conflicting routes fail `route-conflict`; unavailable routes
   fail `route-unavailable`.
5. Each distinct requirement is requested once. Immediately before each provider invocation, the
   gate re-reads its clock and compares it with the request's original timestamp and deadline.
   Rejection, timeout, provider failure, malformed result, missing provider, or failed verification
   is unsatisfied.
6. After approval, the current policy is re-evaluated. Latest allow satisfies and latest deny
   blocks. Latest ask may reuse only approvals with matching authority, approval key, and compatible
   route. Removed obligations are harmless; new or changed obligations return `policy-changed`
   without automatic re-prompting. At most three generation-change restarts are attempted before
   `policy-unstable`.
7. Approved policy changes are offered, prepared, and atomically applied only for the current
   generation, then cause one reload. A provider response batch is limited to 100 entries and the
   aggregate JSON boundary. Generation replacement is serialized with the host atomic `apply`
   callback so it cannot change across that external write. A timeout or abort requests cancellation,
   but an `apply` that ignores its signal retains the mutation barrier until its raw promise settles.
   Their effect is future-only; they never change this result.
8. A configured audit callback must succeed before returning satisfied. `isCurrent` remains a
   generation check, not a transaction lock.

## 4. Reload and race semantics

`reload()` calls `policy.load` at most once for concurrent callers and coalesces them. A successful
load with a changed host revision returns `updated` and increments generation exactly once. The
same revision returns `unchanged` without incrementing. Failed load or invalid state returns
`failed`, emits diagnostics, and retains the last good snapshot. Policy absence is a successful
loaded state with `state: undefined`. Invalid per-call callback timeouts normalize to the bounded
host callback default before `policy.load` is invoked, matching evaluation callback behavior.
Reloads that arrive during a standing-policy atomic apply wait until that callback's raw promise
settles, including after a normalized callback timeout or caller abort. The first subsequent load
therefore observes the applied host state, and concurrent reload callers may coalesce with that
post-apply load. An adapter that ignores cancellation and never settles intentionally keeps this
mutation barrier closed because the library cannot safely declare an external write finished.

An in-flight approval from an old generation is reusable only when the current re-evaluation has
matching obligations; any standing-policy selection attached to it is still discarded as stale.
`isCurrent(result)` compares the generation recorded in the gate's private issued-result registry;
mutating the public result object cannot revive stale work. It returns false after a later generation.
After `evaluate` returns, an independent external change can still race execution.
Hosts requiring strict atomicity must re-check or commit the returned generation with execution.

## 5. Failure and limits

All controlled paths settle rather than reject. Invalid input is `invalid-input`; explicit policy
deny is `policy-denied`; policy load or evaluation failure is `policy-error`; missing HITL is
`hitl-unavailable`; provider failure,
malformed result, rejection, timeout, route, evidence, audit, changed-policy, and instability use
the exact `GateFailure` values above. Raw exceptions never appear in client-safe results.

Human timeout is at most 86,400,000 ms, host callback timeout at most 60,000 ms, and platform
timers at most 2,147,483,647 ms. JSON depth is 32, nodes 10,000, object keys 10,000, total string
code units 262,144; IDs are 256 code units, display text is 16,384 code units, and one approved
provider result may contain at most 100 policy-change responses.

## 6. Versioning and completion

Actual exchanged decision/policy-change envelopes use `schemaVersion: 1`; provider registrations
use `apiVersion: 1` where present. Unknown versions/discriminants fail closed. The project remains
pre-1.0 until its deliberate release-policy check changes that status. Completion requires every
fixture in [conformance.md](conformance.md), root/conformance-only exports, portable built imports,
and standardized typecheck/lint/test/release checks.
