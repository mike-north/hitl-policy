import { describe, expect, it, vi } from 'vitest';
import { askPolicy, approvedDecision, makeGate, makeInput } from './helpers.ts';

function requirement(authorityId: string, approvalKey: string, routeId?: string) {
  return {
    authorityId,
    approvalKey,
    ...(routeId === undefined ? {} : { routeId }),
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn(async (_request: unknown) => approvedDecision()),
    ...overrides,
  };
}

describe('L2 obligations coordinated by createGate', () => {
  it('L2-004 coalesces same approval key and compatible route', async () => {
    const hitl = approval();
    const gate = makeGate({
      policy: {
        evaluate: async () =>
          askPolicy([
            requirement('authority-1', 'key-1', 'route-1'),
            requirement('authority-1', 'key-1', 'route-1'),
          ]),
      },
      hitl,
    });

    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe('satisfied');
    expect(hitl.request).toHaveBeenCalledOnce();
  });

  it('L2-004 treats an unspecified route and one explicit route as compatible', async () => {
    const hitl = approval();
    const gate = makeGate({
      policy: {
        evaluate: async () =>
          askPolicy([
            requirement('authority-1', 'key-1'),
            requirement('authority-1', 'key-1', 'route-1'),
          ]),
      },
      hitl,
    });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'satisfied' });
    expect(hitl.request).toHaveBeenCalledOnce();
    expect(hitl.request).toHaveBeenCalledWith(
      expect.objectContaining({ approval: expect.objectContaining({ routeId: 'route-1' }) }),
      expect.anything(),
    );
  });

  it('L2-004 keeps different approval keys conjunctive', async () => {
    const hitl = approval();
    const gate = makeGate({
      policy: {
        evaluate: async () =>
          askPolicy([
            requirement('authority-1', 'key-1', 'route-1'),
            requirement('authority-1', 'key-2', 'route-1'),
          ]),
      },
      hitl,
    });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'satisfied' });
    expect(hitl.request).toHaveBeenCalledTimes(2);
  });

  it('L2-004 keeps different authorities conjunctive even with equal keys', async () => {
    const hitl = approval();
    const gate = makeGate({
      policy: {
        evaluate: async () =>
          askPolicy([
            requirement('authority-1', 'key-1', 'route-1'),
            requirement('authority-2', 'key-1', 'route-2'),
          ]),
      },
      hitl,
    });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'satisfied' });
    expect(hitl.request).toHaveBeenCalledTimes(2);
  });

  it('L2-005 fails closed for conflicting routes and does not invoke HITL', async () => {
    const hitl = approval();
    const gate = makeGate({
      policy: {
        evaluate: async () =>
          askPolicy([
            requirement('authority-1', 'key-1', 'route-1'),
            requirement('authority-1', 'key-1', 'route-2'),
          ]),
      },
      hitl,
    });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'route-conflict',
    });
    expect(hitl.request).not.toHaveBeenCalled();
  });

  it('L2-007 fails closed when a required route has no provider', async () => {
    const hitl = approval({
      route: vi.fn(() => undefined),
    });
    const gate = makeGate({
      policy: { evaluate: async () => askPolicy([requirement('authority-1', 'key-1', 'missing')]) },
      hitl,
    });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'unsatisfied' });
  });

  it('L2-006 never sends host-native policy details to the HITL request', async () => {
    const hitl = approval();
    const privateDetails = { nativeRule: 'secret', trace: ['private'] };
    const gate = makeGate({
      policy: {
        evaluate: async () => ({
          ...askPolicy(),
          details: privateDetails,
        }),
      },
      hitl,
    });

    await gate.evaluate(makeInput());

    expect(JSON.stringify(hitl.request.mock.calls[0]?.[0] ?? {})).not.toContain('secret');
  });
});
