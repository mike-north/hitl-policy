import { describe, expect, it, vi } from 'vitest';
import type { DecisionProvider } from '../src/index.ts';
import {
  LIMITS,
  invokeDecision,
  isCallerIdentity,
  isDecisionRequest,
  isDecisionResult,
  isJsonValue,
} from '../src/index.ts';
import { approvedDecision, cyclicValue, manyKeys, nestedObject } from './helpers.ts';

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'request-1',
    operationId: 'operation-1',
    operation: { command: 'echo', args: ['hello'] },
    caller: { kind: 'agent', id: 'agent-1' },
    riskClass: 'write',
    summary: 'Run one operation',
    requestedAtMs: 100_000,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function invokeUntrustedProvider(provider: unknown) {
  // Runtime guards must still reject malformed JavaScript providers even though
  // the public TypeScript signature admits only the documented provider shape.
  return invokeDecision(provider as never, request(), { nowMs: () => 100_000 });
}

describe('G-001/G-002/G-003 bounded boundary guards', () => {
  it('G-001 accepts exact limits and rejects depth 33, node 10,001, string 262,145, and keys 10,001', () => {
    expect(isJsonValue(nestedObject(31))).toBe(true);
    expect(isJsonValue(nestedObject(32))).toBe(false);
    expect(isJsonValue(Array.from({ length: 10_000 }, () => 1))).toBe(true);
    expect(isJsonValue(Array.from({ length: 10_001 }, () => 1))).toBe(false);
    expect(isJsonValue('x'.repeat(262_144))).toBe(true);
    expect(isJsonValue('x'.repeat(262_145))).toBe(false);
    expect(isJsonValue(manyKeys(10_000))).toBe(true);
    expect(isJsonValue(manyKeys(10_001))).toBe(false);
    expect(LIMITS.maxJsonDepth).toBe(32);
    expect(LIMITS.maxJsonNodes).toBe(10_000);
    expect(LIMITS.maxStringCodeUnits).toBe(262_144);
    expect(LIMITS.maxObjectKeys).toBe(10_000);
  });

  it('G-001 counts object-key code units cumulatively across siblings', () => {
    const exact = {
      ['a'.repeat(LIMITS.maxStringCodeUnits / 2)]: 0,
      ['b'.repeat(LIMITS.maxStringCodeUnits / 2)]: 0,
    };
    const overLimit = {
      ['a'.repeat(LIMITS.maxStringCodeUnits / 2 + 1)]: 0,
      ['b'.repeat(LIMITS.maxStringCodeUnits / 2 + 1)]: 0,
    };

    expect(isJsonValue(exact)).toBe(true);
    expect(isJsonValue(overLimit)).toBe(false);
  });

  it('G-002 rejects cycles, accessors, functions, symbols, class instances, and non-finite numbers', () => {
    expect(isJsonValue(cyclicValue())).toBe(false);
    expect(isJsonValue(() => undefined)).toBe(false);
    expect(isJsonValue(Symbol('value'))).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);

    let getterInvoked = false;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      get() {
        getterInvoked = true;
        throw new Error('getter must not run');
      },
      enumerable: true,
    });
    expect(isJsonValue(accessor)).toBe(false);
    expect(getterInvoked).toBe(false);

    // ECMAScript exposes no portable, trap-free way to distinguish a transparent
    // Proxy from its target. The guard promises not to read accessors; adapters
    // that accept hostile proxies must reject them before this portable boundary.
  });

  it('G-003 enforces identifier and display-text limits', () => {
    expect(isCallerIdentity({ kind: 'a'.repeat(256), id: 'b'.repeat(256) })).toBe(true);
    expect(isCallerIdentity({ kind: 'a'.repeat(257), id: 'b' })).toBe(false);
    expect(isCallerIdentity({ kind: 'a', id: 'b'.repeat(257) })).toBe(false);
    expect(isDecisionRequest(request({ summary: 'x'.repeat(16_384) }))).toBe(true);
    expect(isDecisionRequest(request({ summary: 'x'.repeat(16_385) }))).toBe(false);
    expect(isDecisionRequest(request({ id: 'x'.repeat(257) }))).toBe(false);
  });

  it('G-004 rejects unknown versions and discriminants on exchanged envelopes', () => {
    expect(isCallerIdentity({ kind: 'agent', id: 'a' })).toBe(true);
    expect(isDecisionRequest({ ...request(), schemaVersion: 2 })).toBe(false);
    expect(isDecisionResult({ schemaVersion: 2, decision: { state: 'approved' } })).toBe(false);
    expect(isDecisionResult({ schemaVersion: 1, decision: { state: 'allow' } })).toBe(false);
  });

  it('G-002/G-004 rejects accessors on exchanged envelopes without invoking them', async () => {
    let getterInvoked = false;
    const providerResult = Object.defineProperty(
      { schemaVersion: 1, decision: { state: 'approved' } },
      'evidence',
      {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error('untrusted accessor must not run');
        },
      },
    );
    const provider = {
      apiVersion: 1,
      providerId: 'provider',
      request: vi.fn(async () => providerResult),
    };

    expect(isDecisionResult(providerResult)).toBe(false);
    await expect(invokeUntrustedProvider(provider)).resolves.toMatchObject({
      decision: { state: 'rejected', failure: 'malformed-result' },
    });
    expect(getterInvoked).toBe(false);
  });
});

describe('L0 failure normalization', () => {
  it('L0-008 rejects unknown provider apiVersion without calling it', async () => {
    const provider = {
      apiVersion: 2,
      providerId: 'provider',
      request: vi.fn(async () => ({ schemaVersion: 1, decision: { state: 'approved' } })),
    };
    await expect(invokeUntrustedProvider(provider)).resolves.toMatchObject({
      decision: { state: 'rejected', failure: 'provider-unavailable' },
    });
    expect(provider.request).not.toHaveBeenCalled();
  });

  it('L0-008 rejects an undocumented requestDecision provider method', async () => {
    const provider = {
      apiVersion: 1,
      providerId: 'provider',
      requestDecision: vi.fn(async () => ({
        schemaVersion: 1,
        decision: { state: 'approved' },
      })),
    };

    await expect(invokeUntrustedProvider(provider)).resolves.toMatchObject({
      decision: { state: 'rejected', failure: 'provider-unavailable' },
    });
    expect(provider.requestDecision).not.toHaveBeenCalled();
  });

  it('L0-004 classifies invalid deadline values as invalid-request rather than deadline-exceeded', async () => {
    const provider = {
      apiVersion: 1,
      providerId: 'provider',
      request: vi.fn(async () => approvedDecision()),
    } satisfies DecisionProvider;
    for (const timeoutMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      LIMITS.maxHumanTimeoutMs + 1,
    ]) {
      await expect(
        invokeDecision(provider, request({ timeoutMs }), { nowMs: () => 100_000 }),
      ).resolves.toMatchObject({
        decision: { state: 'timeout', failure: 'invalid-request' },
      });
    }
    expect(provider.request).not.toHaveBeenCalled();
  });

  it('L0-010 sends provider exceptions to diagnostics without leaking text', async () => {
    const error = new Error('secret provider implementation detail');
    const diagnostics = { report: vi.fn() };
    const provider = {
      apiVersion: 1,
      providerId: 'provider',
      request: vi.fn(async () => Promise.reject(error)),
    } satisfies DecisionProvider;
    const result = await invokeDecision(provider, request(), {
      diagnostics,
      nowMs: () => 100_000,
    });

    expect(result).toMatchObject({ decision: { state: 'rejected', failure: 'provider-error' } });
    expect(JSON.stringify(result)).not.toContain('secret provider implementation detail');
    expect(diagnostics.report).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ phase: 'invoke' }),
    );
  });

  it('L0-011 preserves opaque evidence identity', async () => {
    const evidence = { bytes: new Uint8Array([1, 2, 3]) };
    const provider = {
      apiVersion: 1,
      providerId: 'provider',
      request: vi.fn(async () => approvedDecision(evidence)),
    } satisfies DecisionProvider;
    const result = await invokeDecision(provider, request(), { nowMs: () => 100_000 });
    expect(result.evidence).toBe(evidence);
  });
});
