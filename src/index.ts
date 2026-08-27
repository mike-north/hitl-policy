/**
 * @packageDocumentation
 *
 * Creates the single policy-only, HITL-only, or mixed integration surface.
 */

export { invokeDecision } from './callbacks.js';
export { createGate } from './gate.js';
export {
  isApprovalRequirement,
  isCallerIdentity,
  isDecisionRequest,
  isDecisionResult,
  isJsonValue,
  isPolicyChangeOption,
  isPolicyChangeRequest,
  isPolicyChangeResponse,
  isPolicyAdapter,
  isPolicyDraft,
  isPolicyEvaluation,
} from './guards.js';
export { LIMITS } from './types.js';

export type {
  AbsentPolicyState,
  ApprovalDecisionRequest,
  ApprovalRequirement,
  AskPolicyEvaluation,
  AuditCallback,
  CallerIdentity,
  DecisionFailure,
  DecisionInvocationOptions,
  DecisionOutcome,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionRoute,
  DiagnosticContext,
  DiagnosticReporter,
  DiagnosticSink,
  Gate,
  GateConfig,
  GateEvaluationOptions,
  GateFailure,
  GateInput,
  GateResult,
  HitlAdapter,
  HumanDecisionRecord,
  HumanResolution,
  JsonValue,
  LoadedPolicyState,
  PolicyAdapter,
  PolicyChangeAdapter,
  PolicyChangeContext,
  PolicyChangeOffer,
  PolicyChangeOption,
  PolicyChangeRequest,
  PolicyChangeResponse,
  PolicyChoiceResponse,
  PolicyDraft,
  PolicyEditResponse,
  PolicyEvaluation,
  PolicyEvaluationContext,
  PolicyLoadContext,
  PolicyResolution,
  PolicyState,
  ReloadOptions,
  ReloadResult,
  SatisfiedGateResult,
  TerminalPolicyEvaluation,
  UnsatisfiedGateResult,
} from './types.js';
