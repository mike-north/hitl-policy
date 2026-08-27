import { describe, expect, it, vi } from 'vitest';
import { approvedDecision, askPolicy, deferred, makeGate, makeInput } from './helpers.ts';

function changeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    offers: vi.fn(async () => [
      { id: 'allow-read', label: 'Allow read operations' },
      { id: 'allow-status', label: 'Allow status operations' },
    ]),
    prepare: vi.fn(async (change: unknown) => ({ nativeModification: change })),
    apply: vi.fn(async (_modifications: readonly unknown[]) => true),
    ...overrides,
  };
}

describe('policy modification choices and edits', () => {
  it('CHANGE-001 offers host-authored choices and atomically applies multiple selected modifications', async () => {
    const changes = changeAdapter();
    const approval = {
      implicitRequirement: {
        authorityId: 'authority-1',
        approvalKey: 'operation-1',
      },
      request: vi.fn(async () => ({
        ...approvedDecision(),
        policyChanges: [
          { schemaVersion: 1, type: 'choice', optionId: 'allow-read' },
          { schemaVersion: 1, type: 'choice', optionId: 'allow-status' },
        ],
      })),
    };
    const gate = makeGate({ policy: undefined, hitl: approval, policyChanges: changes });

    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe('satisfied');
    expect(changes.offers).toHaveBeenCalledOnce();
    expect(changes.prepare).toHaveBeenCalledTimes(2);
    expect(changes.apply).toHaveBeenCalledOnce();
    expect(changes.apply.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('CHANGE-002 validates and prepares an editable namespaced JSON draft before apply', async () => {
    const changes = changeAdapter();
    const draft = {
      namespace: 'example.policy',
      kind: 'command-rule',
      value: { prefix: ['git', 'status'] },
    };
    const approval = {
      implicitRequirement: {
        authorityId: 'authority-1',
        approvalKey: 'operation-1',
      },
      request: vi.fn(async () => ({
        ...approvedDecision(),
        policyChanges: [{ schemaVersion: 1, type: 'edit', draft }],
      })),
    };
    const gate = makeGate({ policy: undefined, hitl: approval, policyChanges: changes });

    await gate.evaluate(makeInput());

    expect(changes.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'edit', draft }),
      expect.anything(),
    );
    expect(changes.apply).toHaveBeenCalledOnce();
  });

  it('CHANGE-003 never applies a modification for rejection, timeout, or provider failure', async () => {
    for (const decision of [{ state: 'rejected' }, { state: 'timeout' }]) {
      const changes = changeAdapter();
      const approval = {
        implicitRequirement: {
          authorityId: 'authority-1',
          approvalKey: 'operation-1',
        },
        request: vi.fn(async () => ({ schemaVersion: 1, decision })),
      };
      const gate = makeGate({ policy: undefined, hitl: approval, policyChanges: changes });
      await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'unsatisfied' });
      expect(changes.prepare).not.toHaveBeenCalled();
      expect(changes.apply).not.toHaveBeenCalled();
    }
  });

  it('CHANGE-004 malformed or unauthorized changes leave the one-shot result unchanged', async () => {
    const changes = changeAdapter({
      prepare: vi.fn(async () => {
        throw new Error('unauthorized draft');
      }),
    });
    const approval = {
      implicitRequirement: {
        authorityId: 'authority-1',
        approvalKey: 'operation-1',
      },
      request: vi.fn(async () => ({
        ...approvedDecision(),
        policyChanges: [{ schemaVersion: 1, type: 'edit', draft: { arbitrary: 'untrusted' } }],
      })),
    };
    const gate = makeGate({ policy: undefined, hitl: approval, policyChanges: changes });

    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe('satisfied');
    expect(changes.apply).not.toHaveBeenCalled();
  });

  it('CHANGE-004 discards a complete provider batch when any selected change is malformed', async () => {
    const changes = changeAdapter();
    const approval = {
      implicitRequirement: {
        authorityId: 'authority-1',
        approvalKey: 'operation-1',
      },
      request: vi.fn(async () => ({
        ...approvedDecision(),
        policyChanges: [
          { schemaVersion: 1, type: 'choice', optionId: 'allow-read' },
          { schemaVersion: 2, type: 'choice', optionId: 'malformed' },
        ],
      })),
    };
    const gate = makeGate({ policy: undefined, hitl: approval, policyChanges: changes });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'satisfied' });
    expect(changes.prepare).not.toHaveBeenCalled();
    expect(changes.apply).not.toHaveBeenCalled();
  });

  it('CHANGE-005 discards changes selected against a stale generation', async () => {
    const changes = changeAdapter();
    const waiting = deferred<ReturnType<typeof approvedDecision> & { policyChanges: unknown[] }>();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ revision: 'r1', state: { mode: 'ask' } })
      .mockResolvedValueOnce({ revision: 'r2', state: { mode: 'ask' } });
    const approval = {
      implicitRequirement: {
        authorityId: 'authority-1',
        approvalKey: 'operation-1',
      },
      request: vi.fn(() => waiting.promise),
    };
    const gate = makeGate({
      policy: { load, evaluate: async () => askPolicy() },
      hitl: approval,
      policyChanges: changes,
    });
    const evaluation = gate.evaluate(makeInput());
    await vi.waitFor(() => expect(approval.request).toHaveBeenCalledOnce());
    await gate.reload();
    waiting.resolve({
      ...approvedDecision(),
      policyChanges: [{ schemaVersion: 1, type: 'choice', optionId: 'allow-read' }],
    });

    const result = await evaluation;
    // The matching one-shot approval remains valid after recheck, but the
    // standing-policy selection was made against the old generation.
    expect(result.state).toBe('satisfied');
    expect(changes.apply).not.toHaveBeenCalled();
  });

  it('CHANGE-006 applies accepted changes once, then reloads once; it never changes the current result', async () => {
    const changes = changeAdapter();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ revision: 'r1', state: { mode: 'ask' } })
      .mockResolvedValueOnce({ revision: 'r2', state: { mode: 'allow' } });
    const approval = {
      implicitRequirement: {
        authorityId: 'authority-1',
        approvalKey: 'operation-1',
      },
      request: vi.fn(async () => ({
        ...approvedDecision(),
        policyChanges: [{ schemaVersion: 1, type: 'choice', optionId: 'allow-read' }],
      })),
    };
    const gate = makeGate({
      policy: { load, evaluate: async () => askPolicy() },
      hitl: approval,
      policyChanges: changes,
    });
    await gate.reload();
    const result = await gate.evaluate(makeInput());

    expect(result.state).toBe('satisfied');
    expect(changes.apply).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty('policy', { decision: 'allow' });
  });

  it('CHANGE-007 discards the whole batch when any preparation fails', async () => {
    const changes = changeAdapter({
      prepare: vi
        .fn()
        .mockResolvedValueOnce({ nativeModification: 'first' })
        .mockRejectedValueOnce(new Error('second selection unauthorized')),
    });
    const approval = {
      implicitRequirement: { authorityId: 'authority-1', approvalKey: 'operation-1' },
      request: vi.fn(async () => ({
        ...approvedDecision(),
        policyChanges: [
          { schemaVersion: 1, type: 'choice', optionId: 'allow-read' },
          { schemaVersion: 1, type: 'choice', optionId: 'allow-status' },
        ],
      })),
    };
    const gate = makeGate({ policy: undefined, hitl: approval, policyChanges: changes });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'satisfied' });
    expect(changes.prepare).toHaveBeenCalledTimes(2);
    expect(changes.apply).not.toHaveBeenCalled();
  });

  it('CHANGE-008 a failed reload after atomic apply does not change the current result', async () => {
    const changes = changeAdapter();
    const load = vi.fn(async () => Promise.reject(new Error('reload unavailable')));
    const approval = {
      implicitRequirement: { authorityId: 'authority-1', approvalKey: 'operation-1' },
      request: vi.fn(async () => ({
        ...approvedDecision(),
        policyChanges: [{ schemaVersion: 1, type: 'choice', optionId: 'allow-read' }],
      })),
    };
    const gate = makeGate({
      policy: {
        initial: { revision: 'r1', state: { mode: 'ask' } },
        load,
        evaluate: async () => askPolicy(),
      },
      hitl: approval,
      policyChanges: changes,
    });

    await expect(gate.evaluate(makeInput())).resolves.toMatchObject({ state: 'satisfied' });
    expect(changes.apply).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it('CHANGE-010 serializes snapshot reload with the host atomic apply callback', async () => {
    const applyStarted = deferred<undefined>();
    const releaseApply = deferred<undefined>();
    let revision = 'r1';
    const changes = changeAdapter({
      apply: vi.fn(async () => {
        applyStarted.resolve(undefined);
        await releaseApply.promise;
        revision = 'r2';
        return true;
      }),
    });
    const load = vi.fn(async () => ({ revision, state: { mode: 'ask' } }));
    const approval = {
      implicitRequirement: { authorityId: 'authority-1', approvalKey: 'operation-1' },
      request: vi.fn(async () => ({
        ...approvedDecision(),
        policyChanges: [{ schemaVersion: 1, type: 'choice', optionId: 'allow-read' }],
      })),
    };
    const gate = makeGate({
      policy: {
        initial: { revision, state: { mode: 'ask' } },
        load,
        evaluate: async () => askPolicy(),
      },
      hitl: approval,
      policyChanges: changes,
    });

    const evaluation = gate.evaluate(makeInput());
    await applyStarted.promise;
    const concurrentReload = gate.reload();
    await Promise.resolve();

    expect(load).not.toHaveBeenCalled();
    releaseApply.resolve(undefined);

    await expect(evaluation).resolves.toMatchObject({ state: 'satisfied', generation: 0 });
    await expect(concurrentReload).resolves.toMatchObject({
      status: 'updated',
      generation: 1,
      revision: 'r2',
    });
    expect(load).toHaveBeenCalledOnce();
    expect(gate.generation).toBe(1);
  });
});
