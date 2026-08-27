import type { DecisionFailure, DecisionResult } from '../src/index.ts';

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
