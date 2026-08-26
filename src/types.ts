/**
 * A JSON-compatible value accepted at independently exchanged boundaries.
 *
 * @public
 */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * The fixed resource limits enforced at portable request and change boundaries.
 *
 * @public
 */
export const LIMITS = {
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
  maxObjectKeys: 10_000,
  maxStringCodeUnits: 262_144,
  maxIdentifierCodeUnits: 256,
  maxDisplayCodeUnits: 16_384,
  maxHumanTimeoutMs: 86_400_000,
  maxHostCallbackTimeoutMs: 60_000,
  maxTimerMs: 2_147_483_647,
} as const;

/**
 * Host-owned caller identity embedded in a decision request.
 *
 * @public
 */
export interface CallerIdentity {
  readonly kind: string;
  readonly id: string;
  readonly displayName?: string;
}

/**
 * One stable human-approval obligation emitted by a policy adapter.
 *
 * `approvalKey` identifies the exact obligation that may reuse an in-flight
 * approval after policy re-evaluation. `authorityId` keeps independent
 * authorities conjunctive even when their keys happen to match.
 *
 * @public
 */
export interface ApprovalRequirement {
  readonly authorityId: string;
  readonly approvalKey: string;
  readonly routeId?: string;
}

/**
 * A terminal allow or deny returned by a host policy adapter.
 *
 * @public
 */
export interface TerminalPolicyEvaluation {
  readonly decision: 'allow' | 'deny';
  readonly source: 'directive' | 'default';
  readonly reason?: string;
  /** Opaque host-local provenance which is never inspected or serialized. */
  readonly details?: unknown;
}

/**
 * A terminal ask returned by a host policy adapter.
 *
 * @public
 */
export interface AskPolicyEvaluation {
  readonly decision: 'ask';
  readonly requirements: readonly [ApprovalRequirement, ...ApprovalRequirement[]];
  readonly reason?: string;
  /** Opaque host-local provenance which is never inspected or serialized. */
  readonly details?: unknown;
}

/**
 * The complete terminal result vocabulary of a policy adapter.
 *
 * @public
 */
export type PolicyEvaluation = TerminalPolicyEvaluation | AskPolicyEvaluation;

/**
 * A validated, host-owned policy snapshot.
 *
 * The opaque revision is the host's authoritative identity for the state. A
 * host must issue a new revision whenever the meaning of `state` changes.
 *
 * @public
 */
export interface PolicyState<TPolicy = unknown> {
  readonly revision: string;
  readonly state: TPolicy;
}

/**
 * A successful policy load which intentionally removes the active policy.
 *
 * @public
 */
export interface AbsentPolicyState {
  readonly revision: string;
  readonly state?: undefined;
}

/**
 * The result of a successful host policy load.
 *
 * @public
 */
export type LoadedPolicyState<TPolicy = unknown> = PolicyState<TPolicy> | AbsentPolicyState;

/**
 * Context supplied to policy loading callbacks.
 *
 * @public
 */
export interface PolicyLoadContext {
  readonly signal: AbortSignal;
  readonly generation: number;
}

/**
 * Context supplied to policy evaluation callbacks.
 *
 * @public
 */
export interface PolicyEvaluationContext<TPolicy = unknown> {
  readonly signal: AbortSignal;
  readonly generation: number;
  readonly revision?: string;
  readonly state: TPolicy;
}

/**
 * Host integration for opaque policy state and terminal evaluation.
 *
 * The adapter owns policy syntax, parsing, and validation. `initial`, when
 * present, is already validated; `load` must return only validated state.
 *
 * @public
 */
export interface PolicyAdapter<TInput = unknown, TPolicy = unknown> {
  readonly apiVersion?: 1;
  readonly initial?: LoadedPolicyState<TPolicy>;
  load?(context: PolicyLoadContext): Promise<LoadedPolicyState<TPolicy>>;
  evaluate(
    input: TInput,
    context: PolicyEvaluationContext<TPolicy>,
  ): PolicyEvaluation | Promise<PolicyEvaluation>;
}

/**
 * A request passed through a human-decision provider boundary.
 *
 * @public
 */
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

/**
 * A decision request enriched with the exact approval obligation selected by
 * the gate.
 *
 * @public
 */
export interface ApprovalDecisionRequest<
  TOperation extends JsonValue = JsonValue,
> extends DecisionRequest<TOperation> {
  readonly approval: ApprovalRequirement;
  readonly policyChange?: PolicyChangeRequest;
}

/**
 * Host input from which the gate builds bounded provider requests lazily.
 *
 * @public
 */
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

/**
 * Normalized failures reported inside a human decision outcome.
 *
 * @public
 */
export type DecisionFailure =
  | 'invalid-request'
  | 'provider-error'
  | 'provider-unavailable'
  | 'malformed-result'
  | 'caller-aborted'
  | 'deadline-exceeded';

/**
 * A provider's explicit or normalized human outcome.
 *
 * @public
 */
export type DecisionOutcome =
  | { readonly state: 'approved'; readonly reason?: string; readonly failure?: never }
  | { readonly state: 'rejected'; readonly reason?: string; readonly failure?: DecisionFailure }
  | {
      readonly state: 'timeout';
      readonly reason?: string;
      readonly failure?: 'invalid-request' | 'deadline-exceeded';
    };

/**
 * A result returned through a human-decision provider boundary.
 *
 * Opaque evidence is deliberately not constrained to JSON and is preserved by
 * reference. Invalid policy-change responses are ignored independently of the
 * one-shot decision.
 *
 * @public
 */
export interface DecisionResult {
  readonly schemaVersion: 1;
  readonly decision: DecisionOutcome;
  readonly evidence?: unknown;
  readonly policyChanges?: readonly PolicyChangeResponse[];
}

/**
 * A versioned human-decision provider.
 *
 * @public
 */
export interface DecisionProvider<TOperation extends JsonValue = JsonValue> {
  readonly apiVersion: 1;
  readonly providerId: string;
  request(
    request: ApprovalDecisionRequest<TOperation>,
    context: { readonly signal: AbortSignal },
  ): Promise<DecisionResult>;
}

/**
 * Options for invoking a decision provider directly.
 *
 * @public
 */
export interface DecisionInvocationOptions {
  readonly signal?: AbortSignal;
  readonly nowMs?: () => number;
  readonly diagnostics?: DiagnosticReporter;
}

/**
 * A provider route selected for one approval requirement.
 *
 * @public
 */
export type DecisionRoute<TOperation extends JsonValue = JsonValue> =
  | DecisionProvider<TOperation>
  | {
      readonly providerId?: string;
      request(
        request: ApprovalDecisionRequest<TOperation>,
        context: { readonly signal: AbortSignal },
      ): Promise<DecisionResult>;
    };

/**
 * Host-owned HITL configuration used by the unified gate.
 *
 * @public
 */
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

/**
 * One host-authored standing-policy choice displayed by a provider.
 *
 * @public
 */
export interface PolicyChangeOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * A host-authored, namespaced editable JSON draft.
 *
 * @public
 */
export interface PolicyDraft {
  readonly namespace: string;
  readonly kind: string;
  readonly value: JsonValue;
  readonly display?: string;
}

/**
 * Versioned policy-change material offered across the provider boundary.
 *
 * @public
 */
export interface PolicyChangeRequest {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly options?: readonly PolicyChangeOption[];
  readonly draft?: PolicyDraft;
}

/**
 * A provider selection of one host-authored option.
 *
 * @public
 */
export interface PolicyChoiceResponse {
  readonly schemaVersion: 1;
  readonly type: 'choice';
  readonly optionId: string;
}

/**
 * A provider edit of the host-authored namespaced draft.
 *
 * @public
 */
export interface PolicyEditResponse {
  readonly schemaVersion: 1;
  readonly type: 'edit';
  readonly draft: PolicyDraft;
}

/**
 * One independently exchanged policy-change response.
 *
 * @public
 */
export type PolicyChangeResponse = PolicyChoiceResponse | PolicyEditResponse;

/**
 * Host-authored policy-change offer returned before a human request.
 *
 * @public
 */
export interface PolicyChangeOffer {
  readonly options?: readonly PolicyChangeOption[];
  readonly draft?: PolicyDraft;
}

/**
 * Context supplied while offering, preparing, and applying policy changes.
 *
 * @public
 */
export interface PolicyChangeContext<TInput = unknown> {
  readonly signal: AbortSignal;
  readonly input: TInput;
  readonly generation: number;
  readonly revision?: string;
}

/**
 * Host integration which validates and atomically applies policy changes.
 *
 * `TModification` is deliberately opaque. The gate never interprets or
 * persists it.
 *
 * @public
 */
export interface PolicyChangeAdapter<TInput = unknown, TModification = unknown> {
  readonly apiVersion?: 1;
  offers?(
    context: PolicyChangeContext<TInput>,
  ):
    | PolicyChangeOffer
    | readonly PolicyChangeOption[]
    | Promise<PolicyChangeOffer | readonly PolicyChangeOption[]>;
  prepare(
    change: PolicyChangeResponse,
    context: PolicyChangeContext<TInput>,
  ): TModification | Promise<TModification>;
  apply(
    modifications: readonly TModification[],
    context: PolicyChangeContext<TInput>,
    // `void` intentionally permits a host-owned atomic callback with no
    // acknowledgement value; only an explicit `false` means not applied.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  ): boolean | void | Promise<boolean | void>;
}

/**
 * Structured context attached to a diagnostic exception.
 *
 * @public
 */
export interface DiagnosticContext {
  readonly phase:
    | 'validate'
    | 'policy'
    | 'human'
    | 'route'
    | 'evidence'
    | 'audit'
    | 'reload'
    | 'policy-change'
    | 'invoke';
  readonly requestId?: string;
  readonly providerId?: string;
  readonly generation?: number;
  readonly revision?: string;
}

/**
 * Object-form diagnostic sink.
 *
 * @public
 */
export interface DiagnosticSink {
  report(error: unknown, context: DiagnosticContext): void;
}

/**
 * Accepted object or function form of a diagnostic sink.
 *
 * @public
 */
export type DiagnosticReporter =
  DiagnosticSink | ((error: unknown, context: DiagnosticContext) => void);

/**
 * One normalized human decision paired with its obligation.
 *
 * @public
 */
export interface HumanDecisionRecord {
  readonly requirement: ApprovalRequirement;
  readonly request: ApprovalDecisionRequest;
  readonly result: DecisionResult;
}

/**
 * Human-decision provenance retained by a gate result.
 *
 * @public
 */
export interface HumanResolution {
  readonly decisions: readonly HumanDecisionRecord[];
}

/**
 * Policy provenance retained by a gate result.
 *
 * @public
 */
export type PolicyResolution =
  | (TerminalPolicyEvaluation & {
      readonly generation: number;
      readonly revision?: string;
    })
  | (AskPolicyEvaluation & {
      readonly source: 'directive' | 'implicit';
      readonly generation: number;
      readonly revision?: string;
    });

/**
 * A sanitized reason why the policy/HITL gate is unsatisfied.
 *
 * @public
 */
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

/**
 * A satisfied policy/HITL gate result.
 *
 * This is not ambient authorization. Callers must still combine it with
 * authority and every other application gate.
 *
 * @public
 */
export interface SatisfiedGateResult<TOperation extends JsonValue = JsonValue> {
  readonly state: 'satisfied';
  readonly input: GateInput<TOperation>;
  readonly generation: number;
  readonly revision?: string;
  readonly policy: PolicyResolution;
  readonly human?: HumanResolution;
}

/**
 * An unsatisfied policy/HITL gate result.
 *
 * @public
 */
export interface UnsatisfiedGateResult<TOperation extends JsonValue = JsonValue> {
  readonly state: 'unsatisfied';
  readonly failure: GateFailure;
  readonly input: GateInput<TOperation>;
  readonly generation: number;
  readonly revision?: string;
  readonly policy: PolicyResolution;
  readonly human?: HumanResolution;
}

/**
 * The unified policy/HITL gate result.
 *
 * @public
 */
export type GateResult<TOperation extends JsonValue = JsonValue> =
  SatisfiedGateResult<TOperation> | UnsatisfiedGateResult<TOperation>;

/**
 * Options controlling one gate evaluation.
 *
 * @public
 */
export interface GateEvaluationOptions {
  readonly signal?: AbortSignal;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
  readonly callbackTimeoutMs?: number;
}

/**
 * Options controlling a policy reload.
 *
 * @public
 */
export interface ReloadOptions {
  readonly signal?: AbortSignal;
  readonly callbackTimeoutMs?: number;
}

/**
 * The never-rejecting result of a policy reload.
 *
 * @public
 */
export type ReloadResult =
  | {
      readonly status: 'updated' | 'unchanged';
      readonly generation: number;
      readonly revision: string;
      readonly policy: 'loaded' | 'absent';
    }
  | {
      readonly status: 'failed';
      readonly generation: number;
      readonly revision?: string;
      readonly failure: 'load-unavailable' | 'load-failed' | 'invalid-state' | 'caller-aborted';
    };

/**
 * A durable audit callback. Returning false or throwing fails the gate closed.
 *
 * @public
 */
export type AuditCallback<TOperation extends JsonValue = JsonValue> = (event: {
  readonly input: GateInput<TOperation>;
  readonly generation: number;
  readonly revision?: string;
  readonly policy: PolicyResolution;
  readonly human?: HumanResolution;
}) => boolean | Promise<boolean>;

/**
 * Configuration for the unified gate.
 *
 * @public
 */
export interface GateConfig<
  TOperation extends JsonValue = JsonValue,
  TPolicy = unknown,
  TModification = unknown,
> {
  readonly policy?: PolicyAdapter<GateInput<TOperation>, TPolicy>;
  readonly hitl?: HitlAdapter<TOperation>;
  readonly policyChanges?: PolicyChangeAdapter<GateInput<TOperation>, TModification>;
  readonly audit?: AuditCallback<TOperation>;
  readonly diagnostics?: DiagnosticReporter;
  readonly nowMs?: () => number;
  readonly defaultTimeoutMs?: number;
  readonly callbackTimeoutMs?: number;
}

/**
 * The unified, reloadable policy/HITL gate.
 *
 * @public
 */
export interface Gate<TOperation extends JsonValue = JsonValue> {
  readonly generation: number;
  evaluate(
    input: GateInput<TOperation>,
    options?: GateEvaluationOptions,
  ): Promise<GateResult<TOperation>>;
  reload(options?: ReloadOptions): Promise<ReloadResult>;
  isCurrent(result: GateResult<TOperation>): boolean;
}
