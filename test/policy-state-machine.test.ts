import { describe, expect, it, vi } from 'vitest';
import { createGate } from '../src/index.ts';
import { approvedDecision, askPolicy, deferred, makeGate, makeInput, policy } from './helpers.ts';

function requirement(authorityId: string, approvalKey: string, routeId?: string) {
  return { authorityId, approvalKey, ...(routeId === undefined ? {} : { routeId }) };
}

function hitl(overrides: Record<string, unknown> = {}) {
  return {
    implicitRequirement: requirement('authority-1', 'operation-1'),
    request: vi.fn(async () => approvedDecision()),
    ...overrides,
  };
}

describe('policy snapshot and recheck state machine', () => {
  it('POLICY-001 fails closed on evaluator rejection without falling back or prompting', async () => {
    const diagnostics = vi.fn();
    const approval = hitl();
    const gate = makeGate({
      policy: {
        evaluate: async () => {
          throw new Error('private parser detail');
        },
      },
      hitl: approval,
      diagnostics,
    });

    const result = await gate.evaluate(makeInput());
    expect(result).toMatchObject({ state: 'unsatisfied', failure: 'policy-error' });
    expect(approval.request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private parser detail');
    expect(diagnostics).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: 'policy' }),
    );
  });

  it('POLICY-002 rejects an empty ask as an evaluation error', async () => {
    const approval = hitl();
    const gate = makeGate({
      policy: { evaluate: async () => ({ decision: 'ask', requirements: [] }) },
      hitl: approval,
    });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'policy-error',
    });
    expect(approval.request).not.toHaveBeenCalled();
  });

  it('RELOAD-004 accepts absence with only a host revision', async () => {
    const approval = hitl();
    const gate = createGate({
      policy: {
        load: async () => ({ revision: 'absent-r1' }),
        evaluate: async () => policy('deny'),
      },
      hitl: approval,
    });

    await expect(gate.reload()).resolves.toMatchObject({
      status: 'updated',
      policy: 'absent',
    });
    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'satisfied' });
    expect(approval.request).toHaveBeenCalledOnce();
  });

  it('RELOAD-006 accepts a result from the current gate generation', async () => {
    const gate = makeGate({ policy: { evaluate: async () => policy('allow') } });
    const result = await gate.evaluate(makeInput());
    expect(gate.isCurrent(result)).toBe(true);
  });

  it('RECHECK-005 treats removed obligations as harmless', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(
        askPolicy([requirement('authority-1', 'key-1'), requirement('authority-2', 'key-2')]),
      )
      .mockResolvedValueOnce(askPolicy([requirement('authority-1', 'key-1')]));
    const approval = hitl();
    const gate = makeGate({ policy: { evaluate }, hitl: approval });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'satisfied' });
    expect(approval.request).toHaveBeenCalledTimes(2);
  });

  it('RECHECK-006 blocks a newly introduced conjunctive obligation without re-prompting', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(askPolicy([requirement('authority-1', 'key-1')]))
      .mockResolvedValueOnce(
        askPolicy([requirement('authority-1', 'key-1'), requirement('authority-2', 'key-2')]),
      );
    const approval = hitl();
    const gate = makeGate({ policy: { evaluate }, hitl: approval });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'policy-changed',
    });
    expect(approval.request).toHaveBeenCalledOnce();
  });

  it('RECHECK-003 does not let a provider rewrite the approval key used for policy recheck', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(askPolicy([requirement('authority-1', 'key-1')]))
      .mockResolvedValueOnce(askPolicy([requirement('authority-1', 'key-2')]));
    const approval = hitl({
      request: vi.fn(async (requestValue: unknown) => {
        // Provider input is an untrusted boundary even though the public type is readonly.
        const mutable = requestValue as { approval: { approvalKey: string } };
        mutable.approval.approvalKey = 'key-2';
        return approvedDecision();
      }),
    });
    const gate = makeGate({ policy: { evaluate }, hitl: approval });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'decision-error',
    });
  });

  it('RECHECK-007 reuses a matching approval after a generation change', async () => {
    const waiting = deferred<ReturnType<typeof approvedDecision>>();
    const load = vi.fn(async () => ({ revision: 'r2', state: { mode: 'ask' } }));
    const approval = hitl({ request: vi.fn(() => waiting.promise) });
    const gate = makeGate({
      policy: {
        initial: { revision: 'r1', state: { mode: 'ask' } },
        load,
        evaluate: async () => askPolicy([requirement('authority-1', 'key-1')]),
      },
      hitl: approval,
    });
    const pending = gate.evaluate(makeInput());
    await vi.waitFor(() => expect(approval.request).toHaveBeenCalledOnce());
    await gate.reload();
    waiting.resolve(approvedDecision());

    await expect(pending).resolves.toMatchObject({ state: 'satisfied', generation: 1 });
    expect(approval.request).toHaveBeenCalledOnce();
  });

  it('ASSURE-003 normalizes evidence and audit exceptions independently', async () => {
    const evidenceDiagnostics = vi.fn();
    const evidenceGate = makeGate({
      policy: { evaluate: async () => askPolicy() },
      hitl: hitl({
        verify: async () => {
          throw new Error('private verifier detail');
        },
      }),
      diagnostics: evidenceDiagnostics,
    });
    await expect(evidenceGate.evaluate(makeInput())).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'evidence-failed',
    });
    expect(evidenceDiagnostics).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: 'evidence' }),
    );

    const auditGate = makeGate({
      policy: { evaluate: async () => policy('allow') },
      audit: async () => {
        throw new Error('private audit detail');
      },
    });
    await expect(auditGate.evaluate(makeInput())).resolves.toMatchObject({
      state: 'unsatisfied',
      failure: 'audit-failed',
    });
  });
});
