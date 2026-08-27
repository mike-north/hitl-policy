import { hasValidDecision, isDecisionRequest, isPolicyChangeResponseBatch } from './guards.js';
import type {
  DecisionInvocationOptions,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DiagnosticContext,
  DiagnosticReporter,
  PolicyChangeResponse,
} from './types.js';
import { LIMITS } from './types.js';

/** Reports a raw callback error without allowing a diagnostic sink to break the gate. */
export function reportDiagnostic(
  reporter: DiagnosticReporter | undefined,
  error: unknown,
  context: DiagnosticContext,
): void {
  if (reporter === undefined) {
    return;
  }
  try {
    if (typeof reporter === 'function') {
      reporter(error, context);
    } else {
      reporter.report(error, context);
    }
  } catch {
    // Diagnostic reporting is observational and can never change a gate result.
  }
}

/** Internal outcome of a bounded host callback. */
export type CallbackResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'aborted' }
  | { readonly status: 'timed-out' };

/**
 * Runs an arbitrary host callback with a child signal and a bounded timer.
 *
 * The callback is invoked at most once. Late settlement is observed by the
 * promise machinery but cannot change the already-normalized result.
 */
export async function runHostCallback<T>(
  callback: (signal: AbortSignal) => T | Promise<T>,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
): Promise<CallbackResult<T>> {
  if (options.signal?.aborted === true) {
    return { status: 'aborted' };
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > LIMITS.maxHostCallbackTimeoutMs ||
    options.timeoutMs > LIMITS.maxTimerMs
  ) {
    return { status: 'timed-out' };
  }

  const controller = new AbortController();
  return await new Promise<CallbackResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: CallbackResult<T>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      controller.abort(options.signal?.reason);
      finish({ status: 'aborted' });
    };
    const timer = setTimeout(() => {
      controller.abort(new Error('host callback deadline exceeded'));
      finish({ status: 'timed-out' });
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      Promise.resolve(callback(controller.signal)).then(
        (value) => {
          finish({ status: 'completed', value });
        },
        (error: unknown) => {
          finish({ status: 'failed', error });
        },
      );
    } catch (error: unknown) {
      finish({ status: 'failed', error });
    }
  });
}

function normalizedDecision(
  state: 'rejected' | 'timeout',
  failure:
    | 'invalid-request'
    | 'provider-error'
    | 'provider-unavailable'
    | 'malformed-result'
    | 'caller-aborted'
    | 'deadline-exceeded',
): DecisionResult {
  if (state === 'timeout') {
    return {
      schemaVersion: 1,
      decision: {
        state,
        failure: failure === 'deadline-exceeded' ? failure : 'invalid-request',
      },
    };
  }
  return { schemaVersion: 1, decision: { state, failure } };
}

function requestHasDeadlineShape(request: unknown): request is {
  readonly requestedAtMs: number;
  readonly timeoutMs: number;
} {
  if (typeof request !== 'object' || request === null) {
    return false;
  }
  const record = request as Record<string, unknown>;
  return 'requestedAtMs' in record && 'timeoutMs' in record;
}

function readOwnDataProperty(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProviderResult(value: unknown): DecisionResult | undefined {
  if (!hasValidDecision(value)) {
    return undefined;
  }
  const decision = readOwnDataProperty(value, 'decision') as DecisionResult['decision'];
  const evidence = readOwnDataProperty(value, 'evidence');
  const proposedChanges = readOwnDataProperty(value, 'policyChanges');
  const policyChanges: readonly PolicyChangeResponse[] | undefined = isPolicyChangeResponseBatch(
    proposedChanges,
  )
    ? proposedChanges
    : undefined;

  // Rebuild a plain result without invoking optional accessors. If any change
  // is malformed, discard the whole optional batch while retaining the valid
  // one-shot decision and opaque evidence reference.
  return {
    schemaVersion: 1,
    decision,
    ...(evidence === undefined ? {} : { evidence }),
    ...(policyChanges === undefined ? {} : { policyChanges }),
  };
}

/**
 * Invokes a human-decision provider with deadline, cancellation, and failure
 * normalization. The returned promise never rejects.
 *
 * @public
 */
export function invokeDecision(
  provider: DecisionProvider | undefined,
  request: unknown,
  options?: DecisionInvocationOptions,
): Promise<DecisionResult>;
export async function invokeDecision(
  provider: unknown,
  request: unknown,
  options: DecisionInvocationOptions = {},
): Promise<DecisionResult> {
  let now: number;
  try {
    now = options.nowMs?.() ?? Date.now();
  } catch {
    return normalizedDecision('timeout', 'invalid-request');
  }
  if (!isDecisionRequest(request)) {
    return requestHasDeadlineShape(request)
      ? normalizedDecision('timeout', 'invalid-request')
      : normalizedDecision('rejected', 'invalid-request');
  }
  if (!Number.isSafeInteger(now) || now < 0 || request.requestedAtMs > now) {
    return normalizedDecision('timeout', 'invalid-request');
  }
  const deadline = request.requestedAtMs + request.timeoutMs;
  if (!Number.isSafeInteger(deadline) || deadline < request.requestedAtMs) {
    return normalizedDecision('timeout', 'invalid-request');
  }
  if (deadline <= now) {
    return normalizedDecision('timeout', 'deadline-exceeded');
  }
  if (options.signal?.aborted === true) {
    return normalizedDecision('rejected', 'caller-aborted');
  }

  if (typeof provider !== 'object' || provider === null) {
    return normalizedDecision('rejected', 'provider-unavailable');
  }
  // Provider registration is untrusted boundary data. Read own descriptors
  // exactly once so accessors and hostile descriptor traps cannot run here or
  // be re-read after provider code mutates its registration object.
  const apiVersion = readOwnDataProperty(provider, 'apiVersion');
  const providerId = readOwnDataProperty(provider, 'providerId');
  const requestMethod = readOwnDataProperty(provider, 'request');
  if (
    apiVersion !== 1 ||
    typeof providerId !== 'string' ||
    providerId.length === 0 ||
    typeof requestMethod !== 'function'
  ) {
    return normalizedDecision('rejected', 'provider-unavailable');
  }

  const controller = new AbortController();
  return await new Promise<DecisionResult>((resolve) => {
    let settled = false;
    const finish = (result: DecisionResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      controller.abort(options.signal?.reason);
      finish(normalizedDecision('rejected', 'caller-aborted'));
    };
    const remainingMs = deadline - now;
    const timer = setTimeout(
      () => {
        controller.abort(new Error('human decision deadline exceeded'));
        finish(normalizedDecision('timeout', 'deadline-exceeded'));
      },
      Math.min(remainingMs, LIMITS.maxTimerMs),
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const call = requestMethod as (
        this: unknown,
        requestValue: DecisionRequest,
        context: { readonly signal: AbortSignal },
      ) => unknown;
      Promise.resolve(call.call(provider, request, { signal: controller.signal })).then(
        (value) => {
          const result = normalizeProviderResult(value);
          finish(result ?? normalizedDecision('rejected', 'malformed-result'));
        },
        (error: unknown) => {
          reportDiagnostic(options.diagnostics, error, {
            phase: 'invoke',
            providerId,
            requestId: request.id,
          });
          finish(normalizedDecision('rejected', 'provider-error'));
        },
      );
    } catch (error: unknown) {
      reportDiagnostic(options.diagnostics, error, {
        phase: 'invoke',
        providerId,
        requestId: request.id,
      });
      finish(normalizedDecision('rejected', 'provider-error'));
    }
  });
}
