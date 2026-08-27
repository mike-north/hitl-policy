import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionResult } from '../src/index.ts';
import { invokeDecision, isDecisionResult } from '../src/index.ts';
import { deferred } from './helpers.ts';

const NOW = 100_000;

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'request-1',
    operationId: 'operation-1',
    operation: { action: 'read' },
    caller: { kind: 'agent', id: 'agent-1' },
    summary: 'Read one item',
    requestedAtMs: NOW,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function provider(requestDecision: (signal: AbortSignal) => Promise<unknown>) {
  // These lifecycle tests intentionally feed malformed JavaScript results through
  // the provider boundary, so only the mock result bypasses its static type.
  return {
    apiVersion: 1 as const,
    providerId: 'provider-1',
    request: vi.fn(
      async (_request: unknown, context: { signal: AbortSignal }) =>
        (await requestDecision(context.signal)) as DecisionResult,
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('versioned decision boundary lifecycle', () => {
  it('L0-003 rejects a future timestamp before provider invocation', async () => {
    const decisionProvider = provider(async () => ({
      schemaVersion: 1,
      decision: { state: 'approved' },
    }));

    await expect(
      invokeDecision(decisionProvider, request({ requestedAtMs: NOW + 1 }), {
        nowMs: () => NOW,
      }),
    ).resolves.toMatchObject({ decision: { state: 'timeout', failure: 'invalid-request' } });
    expect(decisionProvider.request).not.toHaveBeenCalled();
  });

  it('L0-005 rejects an already expired request before provider invocation', async () => {
    const decisionProvider = provider(async () => ({
      schemaVersion: 1,
      decision: { state: 'approved' },
    }));

    await expect(
      invokeDecision(decisionProvider, request({ requestedAtMs: NOW - 1_001 }), {
        nowMs: () => NOW,
      }),
    ).resolves.toMatchObject({
      decision: { state: 'timeout', failure: 'deadline-exceeded' },
    });
    expect(decisionProvider.request).not.toHaveBeenCalled();
  });

  it('L0-006 aborts a hung provider at the deadline and ignores a late result', async () => {
    vi.useFakeTimers();
    const waiting = deferred<unknown>();
    let childSignal: AbortSignal | undefined;
    const decisionProvider = provider(async (signal) => {
      childSignal = signal;
      return await waiting.promise;
    });
    const pending = invokeDecision(decisionProvider, request(), { nowMs: () => NOW });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      decision: { state: 'timeout', failure: 'deadline-exceeded' },
    });
    expect(childSignal?.aborted).toBe(true);
    waiting.resolve({ schemaVersion: 1, decision: { state: 'approved' } });
    await vi.runAllTimersAsync();
  });

  it('L0-007 composes caller cancellation into the provider child signal', async () => {
    const controller = new AbortController();
    const waiting = deferred<unknown>();
    let childSignal: AbortSignal | undefined;
    const decisionProvider = provider(async (signal) => {
      childSignal = signal;
      return await waiting.promise;
    });
    const pending = invokeDecision(decisionProvider, request(), {
      nowMs: () => NOW,
      signal: controller.signal,
    });

    controller.abort('caller stopped');
    await expect(pending).resolves.toMatchObject({
      decision: { state: 'rejected', failure: 'caller-aborted' },
    });
    expect(childSignal?.aborted).toBe(true);
  });

  it('L0-009 clears the deadline after an early terminal result', async () => {
    vi.useFakeTimers();
    let childSignal: AbortSignal | undefined;
    const decisionProvider = provider(async (signal) => {
      childSignal = signal;
      return { schemaVersion: 1, decision: { state: 'approved' } };
    });

    await expect(
      invokeDecision(decisionProvider, request(), { nowMs: () => NOW }),
    ).resolves.toMatchObject({ decision: { state: 'approved' } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(childSignal?.aborted).toBe(false);
  });

  it('CHANGE-004 keeps a valid one-shot decision when optional changes are malformed', async () => {
    const decisionProvider = provider(async () => ({
      schemaVersion: 1,
      decision: { state: 'approved' },
      policyChanges: [{ schemaVersion: 2, type: 'choice', optionId: 'invented' }],
    }));

    const result = await invokeDecision(decisionProvider, request(), { nowMs: () => NOW });
    expect(result.decision.state).toBe('approved');
    expect(result.policyChanges).toBeUndefined();
    expect(isDecisionResult(result)).toBe(true);
  });
});
