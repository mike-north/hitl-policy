import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGate } from '../src/index.ts';
import {
  NOW,
  approvedDecision,
  askPolicy,
  deferred,
  makeGate,
  makeInput,
  policy,
} from './helpers.ts';

afterEach(() => {
  vi.useRealTimers();
});

function hitl(overrides: Record<string, unknown> = {}) {
  return {
    implicitRequirement: {
      authorityId: 'authority-1',
      approvalKey: 'operation-1',
    },
    request: vi.fn(async () => approvedDecision()),
    ...overrides,
  };
}

describe('createGate steel threads', () => {
  it('GATE-001 policy-only allow is satisfied without a HITL capability', async () => {
    const request = vi.fn();
    const gate = makeGate({
      policy: { evaluate: async () => policy('allow') },
      hitl: undefined,
    });

    const result = await gate.evaluate(makeInput(), { nowMs: () => NOW });

    expect(result.state).toBe('satisfied');
    expect(result.policy).toMatchObject({ decision: 'allow', source: 'directive' });
    expect(request).not.toHaveBeenCalled();
  });

  it('GATE-002 policy-only deny is unsatisfied and never prompts', async () => {
    const request = vi.fn();
    const gate = makeGate({
      policy: { evaluate: async () => policy('deny') },
      hitl: undefined,
    });

    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe('unsatisfied');
    expect(result.policy).toMatchObject({ decision: 'deny' });
    expect(request).not.toHaveBeenCalled();
  });

  it('GATE-003 absent policy uses implicit ask and succeeds only with HITL', async () => {
    const approval = hitl();
    const gate = createGate({ hitl: approval });

    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe('satisfied');
    expect(result.policy).toMatchObject({ decision: 'ask' });
    expect(approval.request).toHaveBeenCalledOnce();
  });

  it('GATE-004 absent policy with no HITL capability fails closed', async () => {
    const gate = createGate({});

    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe('unsatisfied');
    expect(result).toMatchObject({ failure: 'hitl-unavailable' });
  });

  it.each([
    ['allow', 'satisfied'],
    ['deny', 'unsatisfied'],
  ] as const)('GATE-005 mixed terminal %s does not invoke HITL', async (decision, state) => {
    const approval = hitl();
    const gate = makeGate({
      policy: { evaluate: async () => policy(decision) },
      hitl: approval,
    });

    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe(state);
    expect(approval.request).not.toHaveBeenCalled();
  });

  it('GATE-006 mixed ask invokes HITL, but an approved result is not authorization', async () => {
    const approval = hitl({
      request: vi.fn(async () => approvedDecision({ signed: true })),
    });
    const gate = makeGate({
      policy: { evaluate: async () => askPolicy() },
      hitl: approval,
    });

    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe('satisfied');
    expect(result).not.toHaveProperty('decision', 'allow');
    expect(result).toHaveProperty('human');
  });

  it('GATE-007 re-reads the clock before provider invocation and preserves the request timestamp', async () => {
    const request = vi.fn(async () => approvedDecision());
    const nowMs = vi
      .fn()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW + 1_001);
    const gate = makeGate({
      policy: { evaluate: async () => askPolicy() },
      hitl: hitl({ request }),
    });

    const result = await gate.evaluate(makeInput({ timeoutMs: 1_000 }), { nowMs });

    expect(result).toMatchObject({
      state: 'unsatisfied',
      failure: 'decision-timeout',
      human: {
        decisions: [{ request: { requestedAtMs: NOW, timeoutMs: 1_000 } }],
      },
    });
    expect(nowMs).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('reload snapshots and generation', () => {
  it('RELOAD-001 creates synchronously and exposes generation before I/O', () => {
    const gate = createGate({
      policy: {
        initial: { revision: 'r1', state: { mode: 'allow' } },
        load: vi.fn(async () => ({ revision: 'r2', state: { mode: 'deny' } })),
        evaluate: async () => policy('allow'),
      },
    });

    expect(gate.generation).toBe(0);
  });

  it('RELOAD-002 advances generation only when the host revision changes', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ revision: 'r1', state: { mode: 'allow' } })
      .mockResolvedValueOnce({ revision: 'r2', state: { mode: 'deny' } })
      .mockResolvedValueOnce({ revision: 'r2', state: { mode: 'deny' } });
    const gate = createGate({ policy: { load, evaluate: async () => policy('allow') } });

    const first = await gate.reload();
    const second = await gate.reload();
    const third = await gate.reload();

    expect(first).toMatchObject({ status: 'updated', generation: 1 });
    expect(second).toMatchObject({ status: 'updated', generation: 2 });
    expect(third).toMatchObject({ status: 'unchanged', generation: 2 });
  });

  it('RELOAD-003 keeps the last good snapshot after failed reload', async () => {
    const diagnostics = vi.fn();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ revision: 'r1', state: { mode: 'allow' } })
      .mockRejectedValueOnce(new Error('secret loader failure'));
    const gate = createGate({
      policy: {
        load,
        evaluate: async (_input, context) =>
          policy((context.state as { mode: 'allow' | 'deny' }).mode),
      },
      diagnostics,
    });

    await gate.reload();
    const failed = await gate.reload();
    const evaluated = await gate.evaluate(makeInput());

    expect(failed).toMatchObject({ status: 'failed', generation: 1 });
    expect(evaluated.policy).toMatchObject({ decision: 'allow' });
    expect(diagnostics).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: 'reload' }),
    );
    expect(JSON.stringify(failed)).not.toContain('secret loader failure');
  });

  it('RELOAD-004 successful absence replaces policy and returns to implicit ask', async () => {
    const approval = hitl();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ revision: 'r1', state: { mode: 'allow' } })
      .mockResolvedValueOnce({ revision: 'r2', state: undefined });
    const gate = createGate({
      policy: { load, evaluate: async () => policy('allow') },
      hitl: approval,
    });

    await gate.reload();
    const absent = await gate.reload();
    const evaluated = await gate.evaluate(makeInput());

    expect(absent).toMatchObject({ status: 'updated', generation: 2 });
    expect(evaluated.policy).toMatchObject({ decision: 'ask' });
    expect(approval.request).toHaveBeenCalledOnce();
  });

  it('RELOAD-005 coalesces concurrent reload calls', async () => {
    const loaded = deferred<{ revision: string; state: { mode: string } }>();
    const load = vi.fn(() => loaded.promise);
    const gate = createGate({ policy: { load, evaluate: async () => policy('allow') } });
    const first = gate.reload();
    const second = gate.reload();

    expect(load).toHaveBeenCalledOnce();
    loaded.resolve({ revision: 'r1', state: { mode: 'allow' } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'updated', generation: 1 }),
      expect.objectContaining({ status: 'updated', generation: 1 }),
    ]);
  });

  it('RELOAD-006 isCurrent rejects stale generations and accepts current results', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ revision: 'r1', state: { mode: 'allow' } })
      .mockResolvedValueOnce({ revision: 'r2', state: { mode: 'deny' } });
    const gate = createGate({ policy: { load, evaluate: async () => policy('allow') } });
    await gate.reload();
    const result = await gate.evaluate(makeInput());
    await gate.reload();

    expect(gate.isCurrent(result)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001])(
    'RELOAD-007 normalizes invalid per-call callback timeout %s before loading',
    async (callbackTimeoutMs) => {
      const load = vi.fn(async () => ({ revision: 'r1', state: { mode: 'allow' } }));
      const gate = createGate({ policy: { load, evaluate: async () => policy('allow') } });

      await expect(gate.reload({ callbackTimeoutMs })).resolves.toMatchObject({
        status: 'updated',
        generation: 1,
      });
      expect(load).toHaveBeenCalledOnce();
    },
  );
});

describe('never-reject and assurance gates', () => {
  it('FAIL-001 normalizes provider throw/rejection/malformed output to unsatisfied', async () => {
    for (const request of [
      vi.fn(() => {
        throw new Error('private');
      }),
      vi.fn(async () => Promise.reject(new Error('private'))),
      vi.fn(async () => ({ schemaVersion: 1, decision: { state: 'allow' } })),
    ]) {
      const gate = makeGate({
        policy: { evaluate: async () => askPolicy() },
        hitl: hitl({ request }),
      });
      await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'unsatisfied' });
    }
  });

  it('ASSURE-001 configured evidence failure is a mandatory negative gate', async () => {
    const approval = hitl({ verify: vi.fn(async () => false) });
    const gate = makeGate({ policy: { evaluate: async () => askPolicy() }, hitl: approval });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'evidence-failed',
    });
  });

  it('ASSURE-002 configured audit failure is a mandatory negative gate', async () => {
    const audit = vi.fn(async () => false);
    const gate = makeGate({ policy: { evaluate: async () => policy('allow') }, audit });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'audit-failed',
    });
  });
});

describe('policy recheck during HITL', () => {
  it('RECHECK-001 latest allow satisfies after an in-flight ask', async () => {
    const waiting = deferred<ReturnType<typeof approvedDecision>>();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(askPolicy())
      .mockResolvedValueOnce(policy('allow'));
    const approval = hitl({ request: vi.fn(() => waiting.promise) });
    const gate = makeGate({ policy: { evaluate }, hitl: approval });
    const pending = gate.evaluate(makeInput());
    await vi.waitFor(() => expect(approval.request).toHaveBeenCalledOnce());
    waiting.resolve(approvedDecision());

    await expect(pending).resolves.toMatchObject({ state: 'satisfied' });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('RECHECK-002 latest deny blocks despite approval', async () => {
    const waiting = deferred<ReturnType<typeof approvedDecision>>();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(askPolicy())
      .mockResolvedValueOnce(policy('deny'));
    const approval = hitl({ request: vi.fn(() => waiting.promise) });
    const gate = makeGate({ policy: { evaluate }, hitl: approval });
    const pending = gate.evaluate(makeInput());
    await vi.waitFor(() => expect(approval.request).toHaveBeenCalledOnce());
    waiting.resolve(approvedDecision());

    await expect(pending).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'policy-changed',
    });
  });

  it('RECHECK-003 changed approval key blocks without automatic re-prompt', async () => {
    const waiting = deferred<ReturnType<typeof approvedDecision>>();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(askPolicy())
      .mockResolvedValueOnce(askPolicy([{ authorityId: 'authority-1', approvalKey: 'different' }]));
    const approval = hitl({ request: vi.fn(() => waiting.promise) });
    const gate = makeGate({ policy: { evaluate }, hitl: approval });
    const pending = gate.evaluate(makeInput());
    await vi.waitFor(() => expect(approval.request).toHaveBeenCalledOnce());
    waiting.resolve(approvedDecision());

    await expect(pending).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'policy-changed',
    });
    expect(approval.request).toHaveBeenCalledOnce();
  });

  it('RECHECK-004 stops after three restarts across unstable generations', async () => {
    const waiting = deferred<ReturnType<typeof approvedDecision>>();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ revision: 'r1', state: { mode: 'ask' } })
      .mockResolvedValueOnce({ revision: 'r2', state: { mode: 'ask' } })
      .mockResolvedValueOnce({ revision: 'r3', state: { mode: 'ask' } })
      .mockResolvedValueOnce({ revision: 'r4', state: { mode: 'ask' } });
    const evaluate = vi.fn(async () => {
      // Each post-approval recheck observes a newly loaded generation. The cap must be
      // exercised by genuine generation changes, rather than by repeatedly returning ask.
      if (evaluate.mock.calls.length > 1) await gate.reload();
      return askPolicy();
    });
    const approval = hitl({ request: vi.fn(() => waiting.promise) });
    const gate = makeGate({
      policy: { initial: { revision: 'r0', state: { mode: 'ask' } }, load, evaluate },
      hitl: approval,
    });
    const pending = gate.evaluate(makeInput());
    await vi.waitFor(() => expect(approval.request).toHaveBeenCalledOnce());
    waiting.resolve(approvedDecision());

    await expect(pending).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'policy-unstable',
    });
  });
});
