# hitl-policy

`hitl-policy` is a small, dependency-free TypeScript gate for host-defined policy and optional
human decisions. The same `createGate` / `gate.evaluate` call shape supports policy-only,
HITL-only, and mixed enforcement.

The result is deliberately a gate outcome, not ambient authorization:

```text
effectiveAllow = result.state === "satisfied"
              && ambientAuthority
              && operationSpecificGates
              && executionStillBoundTo(result.generation)
```

## Start with an ordinary host policy

The package does not invent a command, path, selector, or capability language. Your application
keeps its natural policy shape and supplies the small evaluator that understands it. Here is a
complete policy-only gate which allows reads under `/tmp` and denies everything else:

```ts
import { createGate } from 'hitl-policy';
import type { GateInput, PolicyAdapter } from 'hitl-policy';

type Operation =
  { command: 'read'; path: string } | { command: 'write'; path: string; contents: string };

interface FilePolicy {
  readonly defaultDisposition: 'deny';
  readonly allowReadPrefix: string;
}

const filePolicy: FilePolicy = {
  defaultDisposition: 'deny',
  allowReadPrefix: '/tmp/',
};

const policy = {
  initial: { revision: 'file-policy-1', state: filePolicy },
  evaluate(input, { state }) {
    const operation = input.operation;
    if (operation.command === 'read' && operation.path.startsWith(state.allowReadPrefix)) {
      return { decision: 'allow', source: 'directive' } as const;
    }
    return { decision: state.defaultDisposition, source: 'default' } as const;
  },
} satisfies PolicyAdapter<GateInput<Operation>, FilePolicy>;

const gate = createGate<Operation, FilePolicy>({ policy });

const result = await gate.evaluate({
  operationId: 'file.read',
  operation: { command: 'read', path: '/tmp/report.txt' },
  caller: { kind: 'agent', id: 'agent-7' },
  summary: 'Read the generated report',
});

if (result.state === 'satisfied' && gate.isCurrent(result)) {
  // The host still checks ambient authority before using result.input.operation.
}
```

Policy syntax and state remain opaque to `hitl-policy`. The host-issued revision identifies the
meaning of the state; a host must issue a new revision whenever that meaning changes.

## Three steel threads, one call shape

All three integrations call `gate.evaluate(input)`. Only the configured capabilities differ.

### 1. Policy-only

```ts
const gate = createGate({ policy });
const result = await gate.evaluate(input);
```

`allow` is satisfied. `deny`, evaluator failure, malformed output, and `ask` without HITL are
unsatisfied. An allow/deny never invokes a human provider.

### 2. HITL-only: absent policy means ask

```ts
import type { DecisionProvider } from 'hitl-policy';

const provider: DecisionProvider<Operation> = {
  apiVersion: 1,
  providerId: 'approver-app',
  async request(request, { signal }) {
    return await approverApp.requestDecision(request, { signal });
  },
};

const hitl = {
  implicitRequirement: {
    authorityId: 'workspace-owner',
    approvalKey: 'file-operation',
  },
  providerId: provider.providerId,
  request: provider.request.bind(provider),
};

const gate = createGate<Operation>({ hitl });
const result = await gate.evaluate(input);
```

With no active policy snapshot, the gate creates an implicit `ask`. Missing, rejected, timed-out,
cancelled, or malformed human decisions fail closed.

### 3. Mixed allow / deny / ask

Return an ask with one or more stable approval requirements:

```ts
const mixedPolicy = {
  evaluate(input: GateInput<Operation>) {
    if (input.operation.command === 'read') {
      return { decision: 'allow', source: 'directive' } as const;
    }
    return {
      decision: 'ask',
      requirements: [
        {
          authorityId: 'workspace-owner',
          approvalKey: `write:${input.operation.path}`,
        },
      ],
    } as const;
  },
};

const gate = createGate<Operation>({ policy: mixedPolicy, hitl });
const result = await gate.evaluate(input);
```

Equal authority/key obligations coalesce when their routes are compatible. Different keys and
different authorities remain conjunctive. The retained `result.policy` stays `ask` after approval;
the library never manufactures policy `allow` from a human decision.

## Reload policy without replacing the gate

`createGate` is synchronous and performs no I/O. Supply an already validated `initial` snapshot,
or call `reload()` explicitly to load the first one:

```ts
const policy = {
  async load({ signal }) {
    return await policyStore.loadValidated({ signal });
    // { revision: 'file-policy-2', state: nextFilePolicy }
    // { revision: 'file-policy-3' } means successful policy absence.
  },
  evaluate(input: GateInput<Operation>, { state }: { state: FilePolicy }) {
    // Return terminal allow, deny, or ask using the opaque loaded state.
    return evaluateFilePolicy(state, input.operation);
  },
} satisfies PolicyAdapter<GateInput<Operation>, FilePolicy>;

const gate = createGate<Operation, FilePolicy>({ policy, hitl });
const reload = await gate.reload();
```

Reload outcomes are:

| Status      | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `updated`   | Presence or host revision changed; generation advanced exactly once. |
| `unchanged` | Presence and revision are unchanged; generation stayed fixed.        |
| `failed`    | Load failed or was malformed; the last good snapshot remains active. |

Concurrent reload calls coalesce. Successful absence removes the active policy and returns to the
implicit-ask behavior. A human approval is always rechecked against current policy. Latest allow
satisfies; latest deny blocks; latest ask reuses only matching authority/key/route obligations.
New or changed obligations return `policy-changed` without an automatic second prompt.

`isCurrent(result)` is a useful final generation check, not a transaction. Policy can still change
after it returns and before execution. Strict hosts must compare or commit the generation in the
same host-owned operation that performs the action.

`evaluate` detaches and deeply freezes a valid input before calling policy, HITL, audit, or
policy-change adapters. Use `result.input.operation` for execution: it is the exact immutable
operation the gate evaluated, even if the caller later mutates its original object. `isCurrent`
uses the generation privately recorded when that result was issued, not a caller-writable field.

## Host-authorized standing-policy changes

Providers may select host-authored choices or edit a host-authored namespaced JSON draft. Their
responses are untrusted. `prepare` must validate and authorize every response, then translate it
into an opaque native modification. `apply` receives the whole batch once:

```ts
const policyChanges = {
  offers: async () => ({
    options: [{ id: 'allow-read', label: 'Allow future reads in this workspace' }],
    draft: {
      namespace: 'example.file-policy',
      kind: 'path-rule',
      value: { disposition: 'allow', prefix: '/tmp/' },
    },
  }),
  prepare: async (response, context) => {
    return policyStore.validateAndAuthorize(response, context);
  },
  apply: async (modifications) => {
    await policyStore.applyAtomically(modifications);
  },
};

const gate = createGate({ policy, hitl, policyChanges });
```

Choice/edit responses carry `schemaVersion: 1` because they cross the provider boundary. Embedded
requirements, caller identity, policy evaluations, and opaque policy state are host-local and are
not redundantly versioned. Changes apply only after an explicitly approved, verified, audited
decision; stale, malformed, rejected, or failed changes are discarded. A response batch contains at
most 100 changes and must fit the package's aggregate JSON boundary. Snapshot reloads wait while the
host atomic `apply` callback runs; after apply the gate reloads once. The current one-shot result
never changes; only future evaluations see the policy.

## Evidence, audit, and failure safety

- `hitl.verify` and the top-level `audit` callback are optional. Once configured, each must return
  `true` for a satisfied result.
- Provider, policy, route, evidence, audit, load, prepare, and apply exceptions are sanitized. Raw
  values go only to `diagnostics`; returned failures contain no exception text.
- Human timeouts are at most 24 hours. Host callbacks are at most 60 seconds. Platform timers never
  exceed `2^31 - 1` milliseconds.
- Portable JSON boundaries enforce depth 32, 10,000 nodes, 10,000 keys, 262,144 string code units,
  256-code-unit identifiers, and 16,384-code-unit display text.
- Accessors and non-plain objects are rejected without reading getters. JavaScript provides no
  portable trap-free test for a transparent `Proxy`; adapters receiving hostile proxies must reject
  them before this boundary.
- Policy syntax, file watching, persistence, cryptography, evidence meaning, action execution, UI,
  and final ambient authorization remain host-owned.

## Package and traceability

Production APIs are exported from `hitl-policy`; adapter fixtures come from
`hitl-policy/conformance`. There are no public L0–L3 subpaths and no runtime dependencies.

The normative state machine is in [docs/specification.md](docs/specification.md), architecture and
release boundaries are in [docs/architecture.md](docs/architecture.md), and executable requirement
IDs are in [docs/conformance.md](docs/conformance.md). The allw mapping in
[docs/integrations/allw.md](docs/integrations/allw.md) is non-normative.
