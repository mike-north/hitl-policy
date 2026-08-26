import type {
  ApprovalRequirement,
  CallerIdentity,
  DecisionRequest,
  DecisionResult,
  GateInput,
  JsonValue,
  LoadedPolicyState,
  PolicyChangeOffer,
  PolicyChangeOption,
  PolicyChangeRequest,
  PolicyChangeResponse,
  PolicyDraft,
  PolicyAdapter,
  PolicyEvaluation,
} from './types.js';
import { LIMITS } from './types.js';

interface TraversalBudget {
  depth: number;
  keys: number;
  nodes: number;
  strings: number;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function descriptors(value: object): PropertyDescriptorMap | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    // Proxies and revoked proxies may throw while their shape is inspected.
    return undefined;
  }
}

function prototype(value: object): object | null | undefined {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    return undefined;
  }
}

function ownKeys(value: object): readonly PropertyKey[] | undefined {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & {
  value: unknown;
} {
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    !('get' in descriptor) &&
    !('set' in descriptor)
  );
}

function hasOnlyDataProperties(value: object): boolean {
  const valueDescriptors = descriptors(value);
  return valueDescriptors !== undefined && Object.values(valueDescriptors).every(isDataDescriptor);
}

function readDataProperty(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return isDataDescriptor(descriptor) ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max;
}

function isSafeTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(value) && value >= 0
  );
}

function visitJson(
  value: unknown,
  budget: TraversalBudget,
  ancestors: Set<object>,
): value is JsonValue {
  budget.nodes += 1;
  if (budget.nodes > LIMITS.maxJsonNodes) {
    return false;
  }

  if (value === null || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    budget.strings += value.length;
    return budget.strings <= LIMITS.maxStringCodeUnits;
  }
  if (!isRecord(value)) {
    return false;
  }

  const valuePrototype = prototype(value);
  const isArray = Array.isArray(value);
  if (
    valuePrototype === undefined ||
    (isArray
      ? valuePrototype !== Array.prototype
      : valuePrototype !== Object.prototype && valuePrototype !== null)
  ) {
    return false;
  }
  if (budget.depth >= LIMITS.maxJsonDepth || ancestors.has(value)) {
    return false;
  }

  const valueDescriptors = descriptors(value);
  const keys = ownKeys(value);
  if (valueDescriptors === undefined || keys === undefined) {
    return false;
  }
  if (keys.some((key) => typeof key === 'symbol')) {
    return false;
  }

  const stringKeys = keys.filter((key): key is string => typeof key === 'string');
  const dataKeys = isArray ? stringKeys.filter((key) => key !== 'length') : stringKeys;
  budget.keys += dataKeys.length;
  if (budget.keys > LIMITS.maxObjectKeys) {
    return false;
  }

  if (isArray) {
    const lengthDescriptor = valueDescriptors.length;
    if (!isDataDescriptor(lengthDescriptor) || lengthDescriptor.value !== value.length) {
      return false;
    }
    if (dataKeys.length !== value.length || dataKeys.some((key, index) => key !== String(index))) {
      return false;
    }
  }

  ancestors.add(value);
  const nextBudget: TraversalBudget = { ...budget, depth: budget.depth + 1 };
  for (const key of dataKeys) {
    const descriptor = valueDescriptors[key];
    if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
      ancestors.delete(value);
      return false;
    }
    budget.strings += key.length;
    if (
      budget.strings > LIMITS.maxStringCodeUnits ||
      !visitJson(descriptor.value, nextBudget, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
    budget.nodes = nextBudget.nodes;
    budget.keys = nextBudget.keys;
    budget.strings = nextBudget.strings;
  }
  ancestors.delete(value);
  return true;
}

/**
 * Returns whether a value is finite, bounded, accessor-free JSON data.
 *
 * @public
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return visitJson(value, { depth: 0, keys: 0, nodes: -1, strings: 0 }, new Set<object>());
}

/**
 * Returns whether a value is a bounded host caller identity.
 *
 * @public
 */
export function isCallerIdentity(value: unknown): value is CallerIdentity {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const valueDescriptors = descriptors(value);
  if (valueDescriptors === undefined) {
    return false;
  }
  const kind = readDataProperty(value, 'kind');
  const id = readDataProperty(value, 'id');
  const displayName = readDataProperty(value, 'displayName');
  return (
    isBoundedString(kind, LIMITS.maxIdentifierCodeUnits) &&
    isBoundedString(id, LIMITS.maxIdentifierCodeUnits) &&
    (displayName === undefined || isBoundedString(displayName, LIMITS.maxDisplayCodeUnits, true))
  );
}

/**
 * Returns whether a value is a valid approval obligation.
 *
 * @public
 */
export function isApprovalRequirement(value: unknown): value is ApprovalRequirement {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const authorityId = readDataProperty(value, 'authorityId');
  const approvalKey = readDataProperty(value, 'approvalKey');
  const routeId = readDataProperty(value, 'routeId');
  return (
    isBoundedString(authorityId, LIMITS.maxIdentifierCodeUnits) &&
    isBoundedString(approvalKey, LIMITS.maxIdentifierCodeUnits) &&
    (routeId === undefined || isBoundedString(routeId, LIMITS.maxIdentifierCodeUnits))
  );
}

/**
 * Returns whether a value is a terminal host policy evaluation.
 *
 * @public
 */
export function isPolicyEvaluation(value: unknown): value is PolicyEvaluation {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const decision = readDataProperty(value, 'decision');
  const reason = readDataProperty(value, 'reason');
  if (reason !== undefined && !isBoundedString(reason, LIMITS.maxDisplayCodeUnits, true)) {
    return false;
  }
  if (decision === 'allow' || decision === 'deny') {
    const source = readDataProperty(value, 'source');
    return source === 'directive' || source === 'default';
  }
  if (decision !== 'ask') {
    return false;
  }
  const requirements = readDataProperty(value, 'requirements');
  return (
    Array.isArray(requirements) &&
    requirements.length > 0 &&
    requirements.every(isApprovalRequirement)
  );
}

/**
 * Returns whether a value exposes a compatible host policy adapter API.
 *
 * @public
 */
export function isPolicyAdapter(value: unknown): value is PolicyAdapter {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const apiVersion = readDataProperty(value, 'apiVersion');
  const evaluate = readDataProperty(value, 'evaluate');
  const load = readDataProperty(value, 'load');
  return (
    (apiVersion === undefined || apiVersion === 1) &&
    typeof evaluate === 'function' &&
    (load === undefined || typeof load === 'function')
  );
}

function isDecisionOutcome(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const state = readDataProperty(value, 'state');
  const reason = readDataProperty(value, 'reason');
  const failure = readDataProperty(value, 'failure');
  if (reason !== undefined && !isBoundedString(reason, LIMITS.maxDisplayCodeUnits, true)) {
    return false;
  }
  if (state === 'approved') {
    return failure === undefined;
  }
  if (state === 'rejected') {
    return (
      failure === undefined ||
      failure === 'invalid-request' ||
      failure === 'provider-error' ||
      failure === 'provider-unavailable' ||
      failure === 'malformed-result' ||
      failure === 'caller-aborted' ||
      failure === 'deadline-exceeded'
    );
  }
  if (state === 'timeout') {
    return (
      failure === undefined || failure === 'invalid-request' || failure === 'deadline-exceeded'
    );
  }
  return false;
}

/**
 * Returns whether a value is a bounded, version-1 decision request.
 *
 * @public
 */
export function isDecisionRequest(value: unknown): value is DecisionRequest {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const schemaVersion = readDataProperty(value, 'schemaVersion');
  const id = readDataProperty(value, 'id');
  const operationId = readDataProperty(value, 'operationId');
  const operation = readDataProperty(value, 'operation');
  const caller = readDataProperty(value, 'caller');
  const riskClass = readDataProperty(value, 'riskClass');
  const summary = readDataProperty(value, 'summary');
  const requestedAtMs = readDataProperty(value, 'requestedAtMs');
  const timeoutMs = readDataProperty(value, 'timeoutMs');
  const approval = readDataProperty(value, 'approval');
  const policyChange = readDataProperty(value, 'policyChange');
  return (
    schemaVersion === 1 &&
    isBoundedString(id, LIMITS.maxIdentifierCodeUnits) &&
    isBoundedString(operationId, LIMITS.maxIdentifierCodeUnits) &&
    isJsonValue(operation) &&
    isCallerIdentity(caller) &&
    (riskClass === undefined || isBoundedString(riskClass, LIMITS.maxIdentifierCodeUnits)) &&
    isBoundedString(summary, LIMITS.maxDisplayCodeUnits) &&
    isSafeTimestamp(requestedAtMs) &&
    typeof timeoutMs === 'number' &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= LIMITS.maxHumanTimeoutMs &&
    (approval === undefined || isApprovalRequirement(approval)) &&
    (policyChange === undefined || isPolicyChangeRequest(policyChange))
  );
}

function hasValidDecisionResult(value: unknown, validateChanges: boolean): value is DecisionResult {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const schemaVersion = readDataProperty(value, 'schemaVersion');
  const decision = readDataProperty(value, 'decision');
  const policyChanges = readDataProperty(value, 'policyChanges');
  return (
    schemaVersion === 1 &&
    isDecisionOutcome(decision) &&
    (!validateChanges ||
      policyChanges === undefined ||
      (Array.isArray(policyChanges) && policyChanges.every(isPolicyChangeResponse)))
  );
}

/**
 * Returns whether a value is a complete version-1 decision result.
 *
 * @public
 */
export function isDecisionResult(value: unknown): value is DecisionResult {
  return hasValidDecisionResult(value, true);
}

/**
 * Validates the one-shot decision portion independently from optional changes.
 *
 * Malformed policy-change responses must not invalidate a valid one-shot human
 * decision, so provider normalization uses this narrower internal check.
 */
export function hasValidDecision(value: unknown): value is DecisionResult {
  return hasValidDecisionResult(value, false);
}

/**
 * Returns whether a value is a valid policy-change option.
 *
 * @public
 */
export function isPolicyChangeOption(value: unknown): value is PolicyChangeOption {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const id = readDataProperty(value, 'id');
  const label = readDataProperty(value, 'label');
  const description = readDataProperty(value, 'description');
  return (
    isBoundedString(id, LIMITS.maxIdentifierCodeUnits) &&
    isBoundedString(label, LIMITS.maxDisplayCodeUnits) &&
    (description === undefined || isBoundedString(description, LIMITS.maxDisplayCodeUnits, true))
  );
}

/**
 * Returns whether a value is a bounded, namespaced host policy draft.
 *
 * @public
 */
export function isPolicyDraft(value: unknown): value is PolicyDraft {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const namespace = readDataProperty(value, 'namespace');
  const kind = readDataProperty(value, 'kind');
  const draftValue = readDataProperty(value, 'value');
  const display = readDataProperty(value, 'display');
  return (
    isBoundedString(namespace, LIMITS.maxIdentifierCodeUnits) &&
    isBoundedString(kind, LIMITS.maxIdentifierCodeUnits) &&
    isJsonValue(draftValue) &&
    (display === undefined || isBoundedString(display, LIMITS.maxDisplayCodeUnits, true))
  );
}

/**
 * Returns whether a value is valid policy-change material offered to a provider.
 *
 * @public
 */
export function isPolicyChangeRequest(value: unknown): value is PolicyChangeRequest {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const schemaVersion = readDataProperty(value, 'schemaVersion');
  const generation = readDataProperty(value, 'generation');
  const options = readDataProperty(value, 'options');
  const draft = readDataProperty(value, 'draft');
  return (
    schemaVersion === 1 &&
    typeof generation === 'number' &&
    Number.isSafeInteger(generation) &&
    generation >= 0 &&
    (options === undefined ||
      (Array.isArray(options) && options.length > 0 && options.every(isPolicyChangeOption))) &&
    (draft === undefined || isPolicyDraft(draft)) &&
    (options !== undefined || draft !== undefined)
  );
}

/**
 * Returns whether a value is one valid version-1 policy-change response.
 *
 * @public
 */
export function isPolicyChangeResponse(value: unknown): value is PolicyChangeResponse {
  if (
    !isRecord(value) ||
    !hasOnlyDataProperties(value) ||
    readDataProperty(value, 'schemaVersion') !== 1
  ) {
    return false;
  }
  const type = readDataProperty(value, 'type');
  if (type === 'choice') {
    return isBoundedString(readDataProperty(value, 'optionId'), LIMITS.maxIdentifierCodeUnits);
  }
  return type === 'edit' && isPolicyDraft(readDataProperty(value, 'draft'));
}

/** Validates a host-authored offer before it crosses the provider boundary. */
export function isPolicyChangeOffer(value: unknown): value is PolicyChangeOffer {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const options = readDataProperty(value, 'options');
  const draft = readDataProperty(value, 'draft');
  return (
    (options === undefined ||
      (Array.isArray(options) && options.length > 0 && options.every(isPolicyChangeOption))) &&
    (draft === undefined || isPolicyDraft(draft)) &&
    (options !== undefined || draft !== undefined)
  );
}

/** Validates only the host-owned revision envelope around opaque policy state. */
export function isLoadedPolicyState<TPolicy>(value: unknown): value is LoadedPolicyState<TPolicy> {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const revision = readDataProperty(value, 'revision');
  return isBoundedString(revision, LIMITS.maxIdentifierCodeUnits);
}

/** Validates the host input shape used to construct a provider request. */
export function isGateInput(value: unknown): value is GateInput {
  if (!isRecord(value) || !hasOnlyDataProperties(value)) {
    return false;
  }
  const id = readDataProperty(value, 'id');
  const operationId = readDataProperty(value, 'operationId');
  const operation = readDataProperty(value, 'operation');
  const caller = readDataProperty(value, 'caller');
  const riskClass = readDataProperty(value, 'riskClass');
  const summary = readDataProperty(value, 'summary');
  const requestedAtMs = readDataProperty(value, 'requestedAtMs');
  const timeoutMs = readDataProperty(value, 'timeoutMs');
  return (
    (id === undefined || isBoundedString(id, LIMITS.maxIdentifierCodeUnits)) &&
    isBoundedString(operationId, LIMITS.maxIdentifierCodeUnits) &&
    isJsonValue(operation) &&
    isCallerIdentity(caller) &&
    (riskClass === undefined || isBoundedString(riskClass, LIMITS.maxIdentifierCodeUnits)) &&
    (summary === undefined || isBoundedString(summary, LIMITS.maxDisplayCodeUnits)) &&
    (requestedAtMs === undefined || isSafeTimestamp(requestedAtMs)) &&
    (timeoutMs === undefined ||
      (typeof timeoutMs === 'number' &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs > 0 &&
        timeoutMs <= LIMITS.maxHumanTimeoutMs))
  );
}
