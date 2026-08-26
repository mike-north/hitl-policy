import type {
  ApprovalRequirement,
  DecisionProvider,
  DecisionResult,
  Gate,
  GateConfig,
  GateFailure,
  GateResult,
  PolicyAdapter,
  PolicyChangeAdapter,
} from 'hitl-policy';
import { expectError, expectNotAssignable, expectType } from 'tsd';
import { createGate, LIMITS } from 'hitl-policy';

// The unified package does not expose legacy layer-specific limit aliases.
expectError(LIMITS.maxL0TimeoutMs);
expectError(LIMITS.maxL1TimeoutMs);

const requirement: ApprovalRequirement = {
  authorityId: 'authority-1',
  approvalKey: 'key-1',
};
const provider: DecisionProvider = {
  apiVersion: 1,
  providerId: 'provider-1',
  request: async () => ({ schemaVersion: 1, decision: { state: 'approved' } }),
};
const policy: PolicyAdapter = {
  apiVersion: 1,
  evaluate: async () => ({ decision: 'allow', source: 'directive' }),
};
const changes: PolicyChangeAdapter = {
  apiVersion: 1,
  prepare: async () => ({ nativeModification: {} }),
  apply: async () => undefined,
};
expectNotAssignable<PolicyChangeAdapter>({
  prepare: async () => ({ nativeModification: {} }),
  apply: async () => 'not-an-atomic-apply-result',
});
const config: GateConfig = {
  policy,
  hitl: { request: provider.request, implicitRequirement: requirement },
  policyChanges: changes,
};
const gate: Gate = createGate(config);
const result: Promise<GateResult> = gate.evaluate({
  operationId: 'read-1',
  operation: { action: 'read' },
  caller: { kind: 'agent', id: 'agent-1' },
});
void result.then((value) => {
  if (value.state === 'satisfied') {
    expectType<'satisfied'>(value.state);
  } else {
    expectType<'unsatisfied'>(value.state);
    expectType<GateFailure>(value.failure);
  }
});
const decision: DecisionResult = { schemaVersion: 1, decision: { state: 'approved' } };
void decision;

// The unified gate is the supported root surface; no L0/L1 leaf module is required.
