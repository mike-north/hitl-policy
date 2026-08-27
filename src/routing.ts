import { invokeDecision, reportDiagnostic } from './callbacks.js';
import { isApprovalRequirement, isDecisionRequest } from './guards.js';
import type {
  ApprovalDecisionRequest,
  ApprovalRequirement,
  DecisionProvider,
  DecisionResult,
  DiagnosticReporter,
  GateFailure,
  GateInput,
  HitlAdapter,
  HumanDecisionRecord,
  JsonValue,
  PolicyChangeRequest,
} from './types.js';
import { LIMITS } from './types.js';

/** Result of validating and coalescing policy approval obligations. */
export type RequirementNormalization =
  | { readonly ok: true; readonly requirements: readonly ApprovalRequirement[] }
  | { readonly ok: false; readonly failure: 'route-conflict' | 'policy-error' };

/**
 * Coalesces only the same authority/key pair and treats an unspecified route as
 * compatible with one explicit route. Two different explicit routes conflict.
 */
export function normalizeRequirements(
  values: readonly ApprovalRequirement[],
): RequirementNormalization {
  if (values.length === 0 || values.some((value) => !isApprovalRequirement(value))) {
    return { ok: false, failure: 'policy-error' };
  }
  const normalized = new Map<string, ApprovalRequirement>();
  for (const value of values) {
    const identity = `${String(value.authorityId.length)}:${value.authorityId}${value.approvalKey}`;
    const prior = normalized.get(identity);
    if (prior === undefined) {
      normalized.set(identity, value);
      continue;
    }
    if (
      prior.routeId !== undefined &&
      value.routeId !== undefined &&
      prior.routeId !== value.routeId
    ) {
      return { ok: false, failure: 'route-conflict' };
    }
    if (prior.routeId === undefined && value.routeId !== undefined) {
      normalized.set(identity, value);
    }
  }
  return { ok: true, requirements: [...normalized.values()] };
}

function generatedRequestId(input: GateInput, counter: number): string {
  const prefix = input.id ?? input.operationId;
  const suffix = counter.toString(36);
  const available = LIMITS.maxIdentifierCodeUnits - suffix.length - 1;
  return `${prefix.slice(0, Math.max(1, available))}-${suffix}`;
}

function freezeRequestValue(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeRequestValue(child);
  }
  Object.freeze(value);
}

function snapshotRequest<TOperation extends JsonValue>(
  request: ApprovalDecisionRequest<TOperation>,
): ApprovalDecisionRequest<TOperation> | undefined {
  try {
    // Provider input is a detached immutable snapshot. This prevents an
    // untrusted provider from rewriting the approval key or host input that is
    // retained for recheck, evidence verification, and audit provenance.
    const snapshot = structuredClone(request);
    freezeRequestValue(snapshot);
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Builds the default portable request lazily, only after policy asks. */
export function buildDecisionRequest<TOperation extends JsonValue>(options: {
  readonly input: GateInput<TOperation>;
  readonly requirement: ApprovalRequirement;
  readonly nowMs: number;
  readonly timeoutMs: number;
  readonly counter: number;
  readonly policyChange?: PolicyChangeRequest;
}): ApprovalDecisionRequest<TOperation> | undefined {
  const request: ApprovalDecisionRequest<TOperation> = {
    schemaVersion: 1,
    id: generatedRequestId(options.input, options.counter),
    operationId: options.input.operationId,
    operation: options.input.operation,
    caller: options.input.caller,
    ...(options.input.riskClass === undefined ? {} : { riskClass: options.input.riskClass }),
    summary: options.input.summary ?? options.input.operationId,
    requestedAtMs: options.input.requestedAtMs ?? options.nowMs,
    timeoutMs: options.input.timeoutMs ?? options.timeoutMs,
    approval: options.requirement,
    ...(options.policyChange === undefined ? {} : { policyChange: options.policyChange }),
  };
  return isDecisionRequest(request) ? snapshotRequest(request) : undefined;
}

function providerForRequirement<TOperation extends JsonValue>(
  hitl: HitlAdapter<TOperation>,
  requirement: ApprovalRequirement,
  diagnostics: DiagnosticReporter | undefined,
): DecisionProvider<TOperation> | undefined {
  if (hitl.route !== undefined) {
    try {
      const routed = hitl.route(requirement);
      if (routed === undefined) {
        return undefined;
      }
      if ('apiVersion' in routed) {
        return routed;
      }
      return {
        apiVersion: 1,
        providerId: routed.providerId ?? requirement.routeId ?? 'routed-provider',
        request: routed.request.bind(routed),
      };
    } catch (error: unknown) {
      reportDiagnostic(diagnostics, error, { phase: 'route' });
      return undefined;
    }
  }
  return {
    apiVersion: 1,
    providerId: hitl.providerId ?? requirement.routeId ?? 'default-provider',
    request: hitl.request.bind(hitl),
  };
}

/** Invokes one provider per normalized, conjunctive approval requirement. */
export async function requestHumanDecisions<TOperation extends JsonValue>(options: {
  readonly hitl: HitlAdapter<TOperation>;
  readonly requirements: readonly ApprovalRequirement[];
  readonly input: GateInput<TOperation>;
  readonly nowMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly diagnostics?: DiagnosticReporter;
  readonly policyChange?: PolicyChangeRequest;
  readonly nextCounter: () => number;
}): Promise<
  | { readonly ok: true; readonly decisions: readonly HumanDecisionRecord[] }
  | {
      readonly ok: false;
      readonly failure: GateFailure;
      readonly decisions: readonly HumanDecisionRecord[];
    }
> {
  const pending = options.requirements.map(async (requirement) => {
    const request = buildDecisionRequest({
      input: options.input,
      requirement,
      nowMs: options.nowMs,
      timeoutMs: options.timeoutMs,
      counter: options.nextCounter(),
      ...(options.policyChange === undefined ? {} : { policyChange: options.policyChange }),
    });
    if (request === undefined) {
      return { failure: 'invalid-input' as const };
    }
    const provider = providerForRequirement(options.hitl, requirement, options.diagnostics);
    if (provider === undefined) {
      return { failure: 'route-unavailable' as const };
    }
    const result = await invokeDecision(provider, request, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      nowMs: () => options.nowMs,
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    });
    return {
      record: { requirement, request, result } satisfies HumanDecisionRecord,
      failure: decisionFailure(result),
    };
  });

  const resolved = await Promise.all(pending);
  const decisions = resolved.flatMap((item) => ('record' in item ? [item.record] : []));
  const failure = resolved.find((item) => item.failure !== undefined)?.failure;
  return failure === undefined ? { ok: true, decisions } : { ok: false, failure, decisions };
}

/** Maps a normalized provider result to the unified gate failure vocabulary. */
export function decisionFailure(result: DecisionResult): GateFailure | undefined {
  if (result.decision.state === 'approved') {
    return undefined;
  }
  if (result.decision.state === 'timeout') {
    return 'decision-timeout';
  }
  switch (result.decision.failure) {
    case 'caller-aborted':
      return 'caller-aborted';
    case 'malformed-result':
      return 'malformed-decision';
    case 'provider-error':
    case 'provider-unavailable':
    case 'invalid-request':
    case 'deadline-exceeded':
      return 'decision-error';
    case undefined:
      return 'decision-rejected';
  }
  return 'decision-error';
}

/** Whether every latest obligation has an approved key/authority/route match. */
export function approvalsCover(
  latest: readonly ApprovalRequirement[],
  decisions: readonly HumanDecisionRecord[],
): boolean {
  return latest.every((requirement) =>
    decisions.some(
      (record) =>
        record.result.decision.state === 'approved' &&
        record.requirement.authorityId === requirement.authorityId &&
        record.requirement.approvalKey === requirement.approvalKey &&
        (requirement.routeId === undefined || record.requirement.routeId === requirement.routeId),
    ),
  );
}
