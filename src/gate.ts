import { applyPolicyChanges, createPolicyChangeRequest } from './changes.js';
import { reportDiagnostic, runHostCallback } from './callbacks.js';
import { isGateInput, isPolicyAdapter, isPolicyEvaluation } from './guards.js';
import { approvalsCover, normalizeRequirements, requestHumanDecisions } from './routing.js';
import { normalizeCallbackTimeout, type PolicySnapshot, SnapshotStore } from './snapshots.js';
import type {
  AskPolicyEvaluation,
  Gate,
  GateConfig,
  GateEvaluationOptions,
  GateFailure,
  GateInput,
  GateResult,
  HumanResolution,
  JsonValue,
  PolicyEvaluation,
  PolicyResolution,
  ReloadOptions,
  ReloadResult,
} from './types.js';
import { LIMITS } from './types.js';

const MAX_GENERATION_RESTARTS = 3;

type PolicyAttempt =
  | { readonly ok: true; readonly policy: PolicyResolution }
  | {
      readonly ok: false;
      readonly failure: 'policy-error' | 'policy-unstable';
      readonly policy: PolicyResolution;
    };

function revisionFields(revision: string | undefined): { readonly revision?: string } {
  return revision === undefined ? {} : { revision };
}

function implicitPolicy(
  snapshot: PolicySnapshot<unknown>,
  requirement: AskPolicyEvaluation['requirements'][number],
): PolicyResolution {
  return {
    decision: 'ask',
    requirements: [requirement],
    source: 'implicit',
    generation: snapshot.generation,
    ...revisionFields(snapshot.revision),
  };
}

function failedPolicy(snapshot: PolicySnapshot<unknown>): PolicyResolution {
  return {
    decision: 'deny',
    source: 'directive',
    reason: 'Policy evaluation failed',
    generation: snapshot.generation,
    ...revisionFields(snapshot.revision),
  };
}

function policyResolution(
  evaluation: PolicyEvaluation,
  snapshot: PolicySnapshot<unknown>,
): PolicyResolution {
  if (evaluation.decision === 'ask') {
    return {
      ...evaluation,
      source: 'directive',
      generation: snapshot.generation,
      ...revisionFields(snapshot.revision),
    };
  }
  return {
    ...evaluation,
    generation: snapshot.generation,
    ...revisionFields(snapshot.revision),
  };
}

function normalizeHumanTimeout(value: number | undefined): number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= LIMITS.maxHumanTimeoutMs
    ? value
    : 5 * 60_000;
}

/** Implements the unified state machine while keeping every host value opaque. */
class GateImplementation<
  TOperation extends JsonValue,
  TPolicy,
  TModification,
> implements Gate<TOperation> {
  readonly #config: GateConfig<TOperation, TPolicy, TModification>;
  readonly #snapshots: SnapshotStore<GateInput<TOperation>, TPolicy>;
  readonly #results = new WeakSet();
  readonly #callbackTimeoutMs: number;
  readonly #humanTimeoutMs: number;
  #requestCounter = 0;

  constructor(config: GateConfig<TOperation, TPolicy, TModification>) {
    this.#config = config;
    this.#callbackTimeoutMs = normalizeCallbackTimeout(config.callbackTimeoutMs);
    this.#humanTimeoutMs = normalizeHumanTimeout(config.defaultTimeoutMs);
    this.#snapshots = new SnapshotStore({
      adapter: config.policy,
      diagnostics: config.diagnostics,
      defaultTimeoutMs: this.#callbackTimeoutMs,
    });
  }

  get generation(): number {
    return this.#snapshots.generation;
  }

  reload(options?: ReloadOptions): Promise<ReloadResult> {
    return this.#snapshots.reload(options);
  }

  isCurrent(result: GateResult<TOperation>): boolean {
    return this.#results.has(result) && result.generation === this.generation;
  }

  async evaluate(
    input: GateInput<TOperation>,
    options: GateEvaluationOptions = {},
  ): Promise<GateResult<TOperation>> {
    try {
      return await this.#evaluate(input, options);
    } catch (error: unknown) {
      // The public orchestration boundary never rejects. This final catch covers
      // application proxies and runtime failures not handled by narrower seams.
      reportDiagnostic(this.#config.diagnostics, error, {
        phase: 'validate',
        generation: this.generation,
      });
      const snapshot = this.#snapshots.capture();
      return this.#remember(this.#unsatisfied(input, 'invalid-input', failedPolicy(snapshot)));
    }
  }

  async #evaluate(
    input: GateInput<TOperation>,
    options: GateEvaluationOptions,
  ): Promise<GateResult<TOperation>> {
    const snapshot = this.#snapshots.capture();
    if (!isGateInput(input)) {
      return this.#remember(this.#unsatisfied(input, 'invalid-input', failedPolicy(snapshot)));
    }
    const nowMs = options.nowMs?.() ?? this.#config.nowMs?.() ?? Date.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      return this.#remember(this.#unsatisfied(input, 'invalid-input', failedPolicy(snapshot)));
    }
    if (options.signal?.aborted === true) {
      const policy = implicitPolicy(snapshot, this.#implicitRequirement(input));
      return this.#remember(this.#unsatisfied(input, 'caller-aborted', policy));
    }

    const callbackTimeoutMs = normalizeCallbackTimeout(
      options.callbackTimeoutMs ?? this.#callbackTimeoutMs,
    );
    const timeoutMs = normalizeHumanTimeout(
      input.timeoutMs ?? options.timeoutMs ?? this.#humanTimeoutMs,
    );
    const initial = await this.#evaluateStablePolicy(input, options.signal, callbackTimeoutMs);
    if (!initial.ok) {
      return this.#remember(this.#unsatisfied(input, initial.failure, initial.policy));
    }
    if (initial.policy.decision === 'deny') {
      return this.#remember(this.#unsatisfied(input, 'policy-denied', initial.policy));
    }
    if (initial.policy.decision === 'allow') {
      const audited = await this.#audit(
        input,
        initial.policy,
        undefined,
        options.signal,
        callbackTimeoutMs,
      );
      if (!audited) {
        return this.#remember(this.#unsatisfied(input, 'audit-failed', initial.policy));
      }
      if (this.generation !== initial.policy.generation) {
        return this.#remember(this.#unsatisfied(input, 'policy-changed', initial.policy));
      }
      return this.#remember(this.#satisfied(input, initial.policy));
    }

    const normalized = normalizeRequirements(
      (initial.policy as Extract<PolicyResolution, { decision: 'ask' }>).requirements,
    );
    if (!normalized.ok) {
      return this.#remember(this.#unsatisfied(input, normalized.failure, initial.policy));
    }
    const hitl = this.#config.hitl;
    if (hitl === undefined) {
      return this.#remember(this.#unsatisfied(input, 'hitl-unavailable', initial.policy));
    }

    const offeredGeneration = initial.policy.generation;
    const changeRequest = await createPolicyChangeRequest({
      adapter: this.#config.policyChanges,
      input,
      generation: offeredGeneration,
      ...revisionFields(initial.policy.revision),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: callbackTimeoutMs,
      ...(this.#config.diagnostics === undefined ? {} : { diagnostics: this.#config.diagnostics }),
    });
    const human = await requestHumanDecisions({
      hitl,
      requirements: normalized.requirements,
      input,
      nowMs,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(this.#config.diagnostics === undefined ? {} : { diagnostics: this.#config.diagnostics }),
      ...(changeRequest === undefined ? {} : { policyChange: changeRequest }),
      nextCounter: () => {
        this.#requestCounter += 1;
        return this.#requestCounter;
      },
    });
    const humanResolution: HumanResolution = { decisions: human.decisions };
    if (!human.ok) {
      return this.#remember(
        this.#unsatisfied(input, human.failure, initial.policy, humanResolution),
      );
    }
    if (!(await this.#verifyEvidence(hitl, humanResolution, options.signal, callbackTimeoutMs))) {
      return this.#remember(
        this.#unsatisfied(input, 'evidence-failed', initial.policy, humanResolution),
      );
    }

    const latest = await this.#evaluateStablePolicy(input, options.signal, callbackTimeoutMs);
    if (!latest.ok) {
      return this.#remember(
        this.#unsatisfied(input, latest.failure, latest.policy, humanResolution),
      );
    }
    if (latest.policy.decision === 'deny') {
      return this.#remember(
        this.#unsatisfied(input, 'policy-changed', latest.policy, humanResolution),
      );
    }
    if (latest.policy.decision === 'ask') {
      const latestRequirements = normalizeRequirements(latest.policy.requirements);
      if (
        !latestRequirements.ok ||
        !approvalsCover(latestRequirements.requirements, human.decisions)
      ) {
        return this.#remember(
          this.#unsatisfied(input, 'policy-changed', latest.policy, humanResolution),
        );
      }
    }

    if (
      !(await this.#audit(input, latest.policy, humanResolution, options.signal, callbackTimeoutMs))
    ) {
      return this.#remember(
        this.#unsatisfied(input, 'audit-failed', latest.policy, humanResolution),
      );
    }
    if (this.generation !== latest.policy.generation) {
      return this.#remember(
        this.#unsatisfied(input, 'policy-changed', latest.policy, humanResolution),
      );
    }

    const result = this.#remember(this.#satisfied(input, latest.policy, humanResolution));
    const applied = await applyPolicyChanges({
      adapter: this.#config.policyChanges,
      input,
      decisions: human.decisions,
      offeredGeneration,
      ...revisionFields(initial.policy.revision),
      currentGeneration: () => this.generation,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: callbackTimeoutMs,
      ...(this.#config.diagnostics === undefined ? {} : { diagnostics: this.#config.diagnostics }),
    });
    if (applied) {
      // Persistence is host-owned. One coalesced reload makes the applied change
      // visible only to future evaluations; this result retains its old policy.
      await this.reload({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        callbackTimeoutMs,
      });
    }
    return result;
  }

  async #evaluateStablePolicy(
    input: GateInput<TOperation>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<PolicyAttempt> {
    for (let restart = 0; restart <= MAX_GENERATION_RESTARTS; restart += 1) {
      const snapshot = this.#snapshots.capture();
      const attempt = await this.#evaluatePolicySnapshot(input, snapshot, signal, timeoutMs);
      if (!attempt.ok) {
        return attempt;
      }
      if (snapshot.generation === this.generation) {
        return attempt;
      }
    }
    const snapshot = this.#snapshots.capture();
    return {
      ok: false,
      failure: 'policy-unstable',
      policy: failedPolicy(snapshot),
    };
  }

  async #evaluatePolicySnapshot(
    input: GateInput<TOperation>,
    snapshot: PolicySnapshot<TPolicy>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<PolicyAttempt> {
    if (snapshot.kind === 'absent') {
      return {
        ok: true,
        policy: implicitPolicy(snapshot, this.#implicitRequirement(input)),
      };
    }
    const adapter = this.#config.policy;
    if (!isPolicyAdapter(adapter)) {
      return {
        ok: false,
        failure: 'policy-error',
        policy: failedPolicy(snapshot),
      };
    }
    const evaluated = await runHostCallback(
      (childSignal) =>
        adapter.evaluate(input, {
          signal: childSignal,
          generation: snapshot.generation,
          ...revisionFields(snapshot.revision),
          state: snapshot.state,
        }),
      { ...(signal === undefined ? {} : { signal }), timeoutMs },
    );
    if (evaluated.status !== 'completed' || !isPolicyEvaluation(evaluated.value)) {
      if (evaluated.status === 'failed') {
        reportDiagnostic(this.#config.diagnostics, evaluated.error, {
          phase: 'policy',
          generation: snapshot.generation,
          ...revisionFields(snapshot.revision),
        });
      }
      return {
        ok: false,
        failure: 'policy-error',
        policy: failedPolicy(snapshot),
      };
    }
    return {
      ok: true,
      policy: policyResolution(evaluated.value, snapshot),
    };
  }

  #implicitRequirement(input: GateInput<TOperation>): AskPolicyEvaluation['requirements'][number] {
    return (
      this.#config.hitl?.implicitRequirement ?? {
        authorityId: 'implicit-human',
        approvalKey: input.operationId,
      }
    );
  }

  async #verifyEvidence(
    hitl: NonNullable<GateConfig<TOperation>['hitl']>,
    human: HumanResolution,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    if (hitl.verify === undefined) {
      return true;
    }
    for (const record of human.decisions) {
      const verified = await runHostCallback(() => hitl.verify?.(record.result, record.request), {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
      });
      if (verified.status !== 'completed' || verified.value !== true) {
        if (verified.status === 'failed') {
          reportDiagnostic(this.#config.diagnostics, verified.error, {
            phase: 'evidence',
            requestId: record.request.id,
            generation: this.generation,
          });
        }
        return false;
      }
    }
    return true;
  }

  async #audit(
    input: GateInput<TOperation>,
    policy: PolicyResolution,
    human: HumanResolution | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.#config.audit === undefined) {
      return true;
    }
    const audited = await runHostCallback(
      () =>
        this.#config.audit?.({
          input,
          generation: policy.generation,
          ...revisionFields(policy.revision),
          policy,
          ...(human === undefined ? {} : { human }),
        }),
      { ...(signal === undefined ? {} : { signal }), timeoutMs },
    );
    if (audited.status === 'completed') {
      return audited.value === true;
    }
    if (audited.status === 'failed') {
      reportDiagnostic(this.#config.diagnostics, audited.error, {
        phase: 'audit',
        generation: policy.generation,
        ...revisionFields(policy.revision),
      });
    }
    return false;
  }

  #satisfied(
    input: GateInput<TOperation>,
    policy: PolicyResolution,
    human?: HumanResolution,
  ): GateResult<TOperation> {
    return {
      state: 'satisfied',
      input,
      generation: policy.generation,
      ...revisionFields(policy.revision),
      policy,
      ...(human === undefined ? {} : { human }),
    };
  }

  #unsatisfied(
    input: GateInput<TOperation>,
    failure: GateFailure,
    policy: PolicyResolution,
    human?: HumanResolution,
  ): GateResult<TOperation> {
    return {
      state: 'unsatisfied',
      failure,
      input,
      generation: policy.generation,
      ...revisionFields(policy.revision),
      policy,
      ...(human === undefined ? {} : { human }),
    };
  }

  #remember<TResult extends GateResult<TOperation>>(result: TResult): TResult {
    this.#results.add(result);
    return result;
  }
}

/**
 * Creates a synchronous unified gate without performing policy I/O.
 *
 * @public
 */
export function createGate<
  TOperation extends JsonValue = JsonValue,
  TPolicy = unknown,
  TModification = unknown,
>(config: GateConfig<TOperation, TPolicy, TModification>): Gate<TOperation> {
  return new GateImplementation(config);
}
