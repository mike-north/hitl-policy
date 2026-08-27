import { reportDiagnostic, runHostCallback } from './callbacks.js';
import {
  isPolicyChangeOffer,
  isPolicyChangeOption,
  isPolicyChangeResponseBatch,
} from './guards.js';
import type {
  DiagnosticReporter,
  GateInput,
  HumanDecisionRecord,
  JsonValue,
  PolicyChangeAdapter,
  PolicyChangeContext,
  PolicyChangeOffer,
  PolicyChangeRequest,
  PolicyChangeResponse,
} from './types.js';
import { LIMITS } from './types.js';

function contextFor<TInput>(options: {
  readonly signal: AbortSignal;
  readonly input: TInput;
  readonly generation: number;
  readonly revision?: string;
}): PolicyChangeContext<TInput> {
  return {
    signal: options.signal,
    input: options.input,
    generation: options.generation,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
  };
}

function hasCompatibleApiVersion(adapter: object): boolean {
  return !('apiVersion' in adapter) || adapter.apiVersion === 1;
}

/** Loads and validates host-authored change material before a human prompt. */
export async function createPolicyChangeRequest<
  TOperation extends JsonValue,
  TModification,
>(options: {
  readonly adapter: PolicyChangeAdapter<GateInput<TOperation>, TModification> | undefined;
  readonly input: GateInput<TOperation>;
  readonly generation: number;
  readonly revision?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly diagnostics?: DiagnosticReporter;
}): Promise<PolicyChangeRequest | undefined> {
  if (options.adapter?.offers === undefined || !hasCompatibleApiVersion(options.adapter)) {
    return undefined;
  }
  const offered = await runHostCallback(
    (signal) =>
      options.adapter?.offers?.(
        contextFor({
          signal,
          input: options.input,
          generation: options.generation,
          ...(options.revision === undefined ? {} : { revision: options.revision }),
        }),
      ),
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs,
    },
  );
  if (offered.status !== 'completed') {
    if (offered.status === 'failed') {
      reportDiagnostic(options.diagnostics, offered.error, {
        phase: 'policy-change',
        generation: options.generation,
      });
    }
    return undefined;
  }
  const normalized: PolicyChangeOffer = Array.isArray(offered.value)
    ? { options: offered.value.filter(isPolicyChangeOption) }
    : (offered.value as PolicyChangeOffer);
  if (!isPolicyChangeOffer(normalized)) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    generation: options.generation,
    ...(normalized.options === undefined ? {} : { options: normalized.options }),
    ...(normalized.draft === undefined ? {} : { draft: normalized.draft }),
  };
}

/**
 * Validates, prepares, and atomically applies approved provider changes.
 *
 * Any malformed response or failed preparation discards the complete batch.
 * The returned flag reports persistence only; it never changes the one-shot
 * human decision which caused the proposal.
 */
export async function applyPolicyChanges<TOperation extends JsonValue, TModification>(options: {
  readonly adapter: PolicyChangeAdapter<GateInput<TOperation>, TModification> | undefined;
  readonly input: GateInput<TOperation>;
  readonly decisions: readonly HumanDecisionRecord[];
  readonly offeredGeneration: number;
  readonly revision?: string;
  readonly currentGeneration: () => number;
  /** Serializes the host atomic apply callback against snapshot replacement. */
  readonly commit: (operation: () => Promise<boolean>) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly diagnostics?: DiagnosticReporter;
}): Promise<boolean> {
  if (
    options.adapter === undefined ||
    !hasCompatibleApiVersion(options.adapter) ||
    options.currentGeneration() !== options.offeredGeneration ||
    options.decisions.some((record) => record.result.decision.state !== 'approved')
  ) {
    return false;
  }
  const responses: PolicyChangeResponse[] = [];
  for (const record of options.decisions) {
    for (const response of record.result.policyChanges ?? []) {
      if (responses.length >= LIMITS.maxPolicyChangeResponses) {
        return false;
      }
      responses.push(response);
    }
  }
  if (responses.length === 0 || !isPolicyChangeResponseBatch(responses)) {
    return false;
  }

  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted === true) {
    return false;
  }
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const prepared: TModification[] = [];
    for (const response of responses) {
      if (options.currentGeneration() !== options.offeredGeneration) {
        return false;
      }
      const result = await runHostCallback(
        (signal) =>
          options.adapter?.prepare(
            response,
            contextFor({
              signal,
              input: options.input,
              generation: options.offeredGeneration,
              ...(options.revision === undefined ? {} : { revision: options.revision }),
            }),
          ),
        { signal: controller.signal, timeoutMs: options.timeoutMs },
      );
      if (result.status !== 'completed') {
        if (result.status === 'failed') {
          reportDiagnostic(options.diagnostics, result.error, {
            phase: 'policy-change',
            generation: options.offeredGeneration,
          });
        }
        return false;
      }
      prepared.push(result.value as TModification);
    }

    return await options.commit(async () => {
      const applied = await runHostCallback(
        (signal) =>
          options.adapter?.apply(
            prepared,
            contextFor({
              signal,
              input: options.input,
              generation: options.offeredGeneration,
              ...(options.revision === undefined ? {} : { revision: options.revision }),
            }),
          ),
        {
          signal: controller.signal,
          timeoutMs: options.timeoutMs,
          // An external write that ignores cancellation is still live. Keep it
          // inside the snapshot mutation barrier until its promise settles.
          waitForLateSettlement: true,
        },
      );
      if (applied.status !== 'completed') {
        if (applied.status === 'failed') {
          reportDiagnostic(options.diagnostics, applied.error, {
            phase: 'policy-change',
            generation: options.offeredGeneration,
          });
        }
        return false;
      }
      return applied.value !== false;
    });
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
