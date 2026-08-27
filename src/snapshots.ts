import { runHostCallback, reportDiagnostic } from './callbacks.js';
import { isLoadedPolicyState } from './guards.js';
import type {
  DiagnosticReporter,
  LoadedPolicyState,
  PolicyAdapter,
  ReloadOptions,
  ReloadResult,
} from './types.js';
import { LIMITS } from './types.js';

/** Immutable internal policy snapshot captured by one evaluation attempt. */
export type PolicySnapshot<TPolicy> =
  | {
      readonly kind: 'loaded';
      readonly state: TPolicy;
      readonly revision?: string;
      readonly generation: number;
    }
  | {
      readonly kind: 'absent';
      readonly revision?: string;
      readonly generation: number;
    };

/** Result of an operation serialized against snapshot replacement. */
export type CurrentGenerationResult<T> =
  { readonly status: 'completed'; readonly value: T } | { readonly status: 'stale' };

function initialSnapshot<TInput, TPolicy>(
  adapter: PolicyAdapter<TInput, TPolicy> | undefined,
): PolicySnapshot<TPolicy> {
  if (adapter === undefined) {
    return { kind: 'absent', generation: 0 };
  }
  if (adapter.initial !== undefined && isLoadedPolicyState<TPolicy>(adapter.initial)) {
    return adapter.initial.state === undefined
      ? { kind: 'absent', revision: adapter.initial.revision, generation: 0 }
      : {
          kind: 'loaded',
          revision: adapter.initial.revision,
          state: adapter.initial.state,
          generation: 0,
        };
  }
  if (adapter.load === undefined) {
    // A stateless policy adapter is already active and needs no load operation.
    return { kind: 'loaded', state: undefined as TPolicy, generation: 0 };
  }
  return { kind: 'absent', generation: 0 };
}

function sameSnapshot<TPolicy>(
  current: PolicySnapshot<TPolicy>,
  loaded: LoadedPolicyState<TPolicy>,
): boolean {
  const nextKind = loaded.state === undefined ? 'absent' : 'loaded';
  // Revisions are host-issued content identities. Opaque state cannot be
  // compared safely, so the host must change the revision when meaning changes.
  return current.kind === nextKind && current.revision === loaded.revision;
}

/** Preserves Error objects and safely wraps non-Error promise rejection reasons. */
function mutationError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('snapshot mutation failed', { cause: reason });
}

/** Owns atomic snapshot replacement and coalesced reload operations. */
export class SnapshotStore<TInput, TPolicy> {
  readonly #adapter: PolicyAdapter<TInput, TPolicy> | undefined;
  readonly #diagnostics: DiagnosticReporter | undefined;
  readonly #defaultTimeoutMs: number;
  #snapshot: PolicySnapshot<TPolicy>;
  #inFlight: Promise<ReloadResult> | undefined;
  #mutationActive = false;
  readonly #mutationQueue: (() => void)[] = [];

  constructor(options: {
    readonly adapter: PolicyAdapter<TInput, TPolicy> | undefined;
    readonly diagnostics: DiagnosticReporter | undefined;
    readonly defaultTimeoutMs: number;
  }) {
    this.#adapter = options.adapter;
    this.#diagnostics = options.diagnostics;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    this.#snapshot = initialSnapshot(options.adapter);
  }

  get generation(): number {
    return this.#snapshot.generation;
  }

  capture(): PolicySnapshot<TPolicy> {
    return this.#snapshot;
  }

  reload(options: ReloadOptions = {}): Promise<ReloadResult> {
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }
    const operation = this.#serializeMutation(() => this.#performReload(options)).finally(() => {
      if (this.#inFlight === operation) {
        this.#inFlight = undefined;
      }
    });
    this.#inFlight = operation;
    return operation;
  }

  /**
   * Runs an external mutation only if its generation is still current while
   * preventing reload from replacing the snapshot until that mutation settles.
   */
  runWhileCurrent<T>(
    generation: number,
    operation: () => Promise<T>,
  ): Promise<CurrentGenerationResult<T>> {
    return this.#serializeMutation(async () => {
      if (this.#snapshot.generation !== generation) {
        return { status: 'stale' };
      }
      return { status: 'completed', value: await operation() };
    });
  }

  /** Starts uncontended mutations synchronously and queues later mutations FIFO. */
  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        this.#mutationActive = true;
        let result: Promise<T>;
        try {
          result = operation();
        } catch (error: unknown) {
          this.#releaseMutation();
          reject(mutationError(error));
          return;
        }
        void result.then(
          (value) => {
            this.#releaseMutation();
            resolve(value);
          },
          (error: unknown) => {
            this.#releaseMutation();
            reject(mutationError(error));
          },
        );
      };
      if (this.#mutationActive) {
        this.#mutationQueue.push(run);
      } else {
        run();
      }
    });
  }

  /** Releases one mutation and immediately starts the next queued operation. */
  #releaseMutation(): void {
    const next = this.#mutationQueue.shift();
    if (next === undefined) {
      this.#mutationActive = false;
    } else {
      next();
    }
  }

  async #performReload(options: ReloadOptions): Promise<ReloadResult> {
    const adapter = this.#adapter;
    if (adapter?.load === undefined) {
      return this.#failed('load-unavailable');
    }
    const load = adapter.load.bind(adapter);
    const captured = this.#snapshot;
    const timeoutMs = normalizeCallbackTimeout(options.callbackTimeoutMs ?? this.#defaultTimeoutMs);
    const loaded = await runHostCallback(
      (signal) => load({ signal, generation: captured.generation }),
      { ...(options.signal === undefined ? {} : { signal: options.signal }), timeoutMs },
    );
    if (loaded.status === 'aborted') {
      return this.#failed('caller-aborted');
    }
    if (loaded.status === 'timed-out') {
      reportDiagnostic(this.#diagnostics, new Error('policy load timed out'), {
        phase: 'reload',
        generation: captured.generation,
        ...(captured.revision === undefined ? {} : { revision: captured.revision }),
      });
      return this.#failed('load-failed');
    }
    if (loaded.status === 'failed') {
      reportDiagnostic(this.#diagnostics, loaded.error, {
        phase: 'reload',
        generation: captured.generation,
        ...(captured.revision === undefined ? {} : { revision: captured.revision }),
      });
      return this.#failed('load-failed');
    }
    if (!isLoadedPolicyState<TPolicy>(loaded.value)) {
      return this.#failed('invalid-state');
    }

    // Snapshot replacement is one synchronous assignment: readers observe the
    // complete old or complete new snapshot, never a mixed revision/state pair.
    if (sameSnapshot(this.#snapshot, loaded.value)) {
      return {
        status: 'unchanged',
        generation: this.#snapshot.generation,
        revision: loaded.value.revision,
        policy: loaded.value.state === undefined ? 'absent' : 'loaded',
      };
    }
    const generation = this.#snapshot.generation + 1;
    this.#snapshot =
      loaded.value.state === undefined
        ? { kind: 'absent', revision: loaded.value.revision, generation }
        : {
            kind: 'loaded',
            revision: loaded.value.revision,
            state: loaded.value.state,
            generation,
          };
    return {
      status: 'updated',
      generation,
      revision: loaded.value.revision,
      policy: this.#snapshot.kind,
    };
  }

  #failed(failure: Extract<ReloadResult, { status: 'failed' }>['failure']): ReloadResult {
    return {
      status: 'failed',
      generation: this.#snapshot.generation,
      ...(this.#snapshot.revision === undefined ? {} : { revision: this.#snapshot.revision }),
      failure,
    };
  }
}

/** Normalizes an invalid host callback timeout to the bounded safe default. */
export function normalizeCallbackTimeout(value: number | undefined): number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= LIMITS.maxHostCallbackTimeoutMs
    ? value
    : LIMITS.maxHostCallbackTimeoutMs;
}
