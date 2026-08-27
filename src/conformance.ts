import type {
  ApprovalDecisionRequest,
  ApprovalRequirement,
  DecisionProvider,
  DecisionResult,
  GateInput,
  JsonValue,
  LoadedPolicyState,
  PolicyAdapter,
  PolicyChangeAdapter,
} from './index.js';

/**
 * Stable requirement IDs implemented by the first conformance fixture set.
 *
 * @public
 */
export const CONFORMANCE_REQUIREMENTS = [
  'GATE-001',
  'GATE-002',
  'GATE-003',
  'GATE-004',
  'GATE-005',
  'GATE-006',
  'RELOAD-001',
  'RELOAD-002',
  'RELOAD-003',
  'RELOAD-004',
  'RELOAD-005',
  'RELOAD-006',
  'RECHECK-001',
  'RECHECK-002',
  'RECHECK-003',
  'RECHECK-004',
  'CHANGE-001',
  'CHANGE-002',
  'CHANGE-003',
  'CHANGE-004',
  'CHANGE-005',
  'CHANGE-006',
  'CHANGE-007',
  'CHANGE-008',
] as const;

/**
 * One intentionally simple host policy shape used by adapter conformance tests.
 *
 * @public
 */
export interface ConformancePolicyState {
  readonly disposition: 'allow' | 'ask' | 'deny';
  readonly requirement?: ApprovalRequirement;
}

/**
 * Builds a bounded host input suitable for all three steel-thread examples.
 *
 * @public
 */
export function createGateInputFixture<TOperation extends JsonValue = JsonValue>(
  operation: TOperation = { action: 'read' } as unknown as TOperation,
): GateInput<TOperation> {
  return {
    operationId: 'operation-1',
    operation,
    caller: { kind: 'agent', id: 'agent-1' },
    summary: 'Perform one conformance operation',
    requestedAtMs: 100_000,
    timeoutMs: 1_000,
  };
}

/**
 * Builds a portable decision request for provider conformance tests.
 *
 * @public
 */
export function createDecisionRequestFixture(
  overrides: Partial<ApprovalDecisionRequest> = {},
): ApprovalDecisionRequest {
  return {
    schemaVersion: 1,
    id: 'request-1',
    operationId: 'operation-1',
    operation: { action: 'read' },
    caller: { kind: 'agent', id: 'agent-1' },
    summary: 'Perform one conformance operation',
    requestedAtMs: 100_000,
    timeoutMs: 1_000,
    approval: { authorityId: 'authority-1', approvalKey: 'key-1' },
    ...overrides,
  };
}

/**
 * Builds an explicit approved decision with optional opaque evidence.
 *
 * @public
 */
export function createApprovedDecisionFixture(evidence?: unknown): DecisionResult {
  return {
    schemaVersion: 1,
    decision: { state: 'approved' },
    ...(evidence === undefined ? {} : { evidence }),
  };
}

/**
 * Builds an explicit human rejection rather than a provider failure.
 *
 * @public
 */
export function createRejectedDecisionFixture(): DecisionResult {
  return { schemaVersion: 1, decision: { state: 'rejected' } };
}

/**
 * Builds a provider which never settles, for deadline and cancellation tests.
 *
 * @public
 */
export function createHungProviderFixture(): DecisionProvider {
  return {
    apiVersion: 1,
    providerId: 'hung-provider',
    request: async () => await new Promise<DecisionResult>(() => undefined),
  };
}

/**
 * Builds a validated opaque policy snapshot with a host revision.
 *
 * @public
 */
export function createPolicyStateFixture(
  disposition: ConformancePolicyState['disposition'] = 'allow',
  revision = 'revision-1',
): LoadedPolicyState<ConformancePolicyState> {
  return { revision, state: { disposition } };
}

/**
 * Builds a tiny policy adapter proving that policy syntax remains host-owned.
 *
 * @public
 */
export function createPolicyAdapterFixture(
  state: LoadedPolicyState<ConformancePolicyState> = createPolicyStateFixture(),
): PolicyAdapter<GateInput, ConformancePolicyState> {
  return {
    apiVersion: 1,
    initial: state,
    evaluate: (_input, context) => {
      if (context.state.disposition === 'ask') {
        return {
          decision: 'ask',
          requirements: [
            context.state.requirement ?? {
              authorityId: 'authority-1',
              approvalKey: 'key-1',
            },
          ],
        };
      }
      return { decision: context.state.disposition, source: 'directive' };
    },
  };
}

/**
 * Builds an in-memory adapter fixture which records one atomic change batch.
 *
 * @public
 */
export function createPolicyChangeAdapterFixture(): PolicyChangeAdapter<GateInput> & {
  readonly applied: readonly (readonly unknown[])[];
} {
  const applied: (readonly unknown[])[] = [];
  return {
    apiVersion: 1,
    offers: () => [{ id: 'allow-operation', label: 'Allow this operation later' }],
    prepare: (change) => change,
    apply: (modifications) => {
      applied.push(modifications);
    },
    applied,
  };
}
