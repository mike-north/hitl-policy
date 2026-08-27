import { createGate } from '../src/index.ts';
import type {
  ApprovalRequirement,
  AskPolicyEvaluation,
  DecisionFailure,
  DecisionResult,
  GateConfig,
  GateInput,
  TerminalPolicyEvaluation,
} from '../src/index.ts';

export const NOW = 100_000;

export function makeInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    operationId: 'operation-1',
    operation: { command: 'echo', args: ['hello'] },
    caller: { kind: 'agent', id: 'agent-1' },
    ...overrides,
  };
}

export function approvedDecision(evidence?: unknown): DecisionResult {
  return {
    schemaVersion: 1,
    decision: { state: 'approved' as const },
    ...(evidence === undefined ? {} : { evidence }),
  };
}

export function rejectedDecision(failure?: DecisionFailure): DecisionResult {
  return {
    schemaVersion: 1,
    decision: {
      state: 'rejected' as const,
      ...(failure === undefined ? {} : { failure }),
    },
  };
}

export function askPolicy(
  requirements: readonly [ApprovalRequirement, ...ApprovalRequirement[]] = [
    { authorityId: 'authority-1', approvalKey: 'operation-1' },
  ],
): AskPolicyEvaluation {
  return {
    decision: 'ask' as const,
    requirements,
  };
}

export function policy(
  decision: 'allow' | 'deny',
  source: 'directive' | 'default' = 'directive',
): TerminalPolicyEvaluation {
  return { decision, source };
}

export function makeGateConfig(overrides: Record<string, unknown> = {}): GateConfig {
  const config = {
    policy: {
      evaluate: async () => policy('allow'),
    },
    ...overrides,
  };

  // Runtime-boundary tests intentionally inject malformed provider and policy
  // values that cannot be expressed through the public static contract.
  return config;
}

export function makeGate(overrides: Record<string, unknown> = {}) {
  return createGate(makeGateConfig(overrides));
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function cyclicValue(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

export function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

export function manyKeys(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`key-${String(index)}`, index]),
  );
}
