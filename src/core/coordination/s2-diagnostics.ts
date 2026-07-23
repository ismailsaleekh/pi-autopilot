import type { CoordinationFailureCode, CoordinationRuntimeError } from './failures.ts';
import { decideS2CoordinationFailure, type S2CoordinationFailureDecision } from './s2-failure-taxonomy.ts';

export const S2_FAILURE_DIAGNOSTIC_SCHEMA_VERSION = 'autopilot.s2.failure_diagnostic.v1';

export const S2_DIAGNOSTIC_MAX_EVIDENCE_ENTRIES = 24;
export const S2_DIAGNOSTIC_MAX_TEXT_CODE_POINTS = 320;
export const S2_DIAGNOSTIC_MAX_MESSAGE_CODE_POINTS = 640;
export const S2_DIAGNOSTIC_MAX_TOTAL_CODE_POINTS = 4_096;

export interface S2CoordinationFailureDiagnosticInput<Code extends CoordinationFailureCode = CoordinationFailureCode> {
  readonly code: Code;
  readonly message: string;
  readonly evidence: readonly string[];
}

export interface S2DiagnosticTruncation {
  readonly omitted_entries: number;
  readonly omitted_code_points: number;
}

export interface S2CoordinationFailureDiagnostic<Code extends CoordinationFailureCode = CoordinationFailureCode> {
  readonly schema_version: typeof S2_FAILURE_DIAGNOSTIC_SCHEMA_VERSION;
  readonly decision: S2CoordinationFailureDecision<Code>;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly truncation: S2DiagnosticTruncation;
  readonly redacted: boolean;
}

interface SanitizedText {
  readonly text: string;
  readonly redacted: boolean;
  readonly omitted_code_points: number;
}

const AUTHORITY_SECRET_KEY_PATTERN = [
  'authorization',
  'x[_-]?api[_-]?key',
  '(?:[a-z0-9]+[_-])*api[_-]?key',
  '(?:[a-z0-9]+[_-])*(?:access[_-]?token|refresh[_-]?token|session[_-]?token|handoff[_-]?token|child[_-]?token|lock[_-]?token|freeze[_-]?token)',
  '(?:[a-z0-9]+[_-])*(?:lease[_-]?capability|capability|client[_-]?secret|secret[_-]?access[_-]?key|secret|private[_-]?key|password)',
  'token',
].join('|');

const SECRET_VALUE_PATTERN = String.raw`"[^"]*"|'[^']*'|[^\s,;}]+`;
const QUOTED_SECRET_PROPERTY_PATTERN = new RegExp(`("(?:${AUTHORITY_SECRET_KEY_PATTERN})"\\s*:\\s*)(?:${SECRET_VALUE_PATTERN})`, 'giu');
const AUTHORIZATION_HEADER_PATTERN = new RegExp(`\\b(authorization)(\\s*(?:[=:]\\s*(?:(?:bearer|basic|token)\\s+)?|(?:bearer|basic|token)\\s+))(?:${SECRET_VALUE_PATTERN})`, 'giu');
const ASSIGNED_SECRET_PATTERN = new RegExp(`\\b((?!(?:authorization)\\b)(?:${AUTHORITY_SECRET_KEY_PATTERN}))(\\s*[=:]\\s*)(?:${SECRET_VALUE_PATTERN})`, 'giu');

function sanitizeS2DiagnosticText(value: string, maximumCodePoints: number): SanitizedText {
  const withoutControls = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '\uFFFD');
  const withoutLabeledSecrets = withoutControls
    .replace(QUOTED_SECRET_PROPERTY_PATTERN, '$1"<redacted>"')
    .replace(AUTHORIZATION_HEADER_PATTERN, '$1$2<redacted>')
    .replace(ASSIGNED_SECRET_PATTERN, '$1$2<redacted>');
  const redacted = withoutLabeledSecrets !== value;
  const points = [...withoutLabeledSecrets];
  if (points.length <= maximumCodePoints) return { text: withoutLabeledSecrets, redacted, omitted_code_points: 0 };
  const suffix = '…[truncated]';
  const suffixPoints = [...suffix];
  const retained = points.slice(0, Math.max(0, maximumCodePoints - suffixPoints.length)).join('');
  return { text: `${retained}${suffix}`, redacted, omitted_code_points: points.length - [...retained].length };
}

function boundedS2Evidence(values: readonly string[]): { readonly evidence: readonly string[]; readonly truncation: S2DiagnosticTruncation; readonly redacted: boolean } {
  const output: string[] = [];
  let omittedEntries = 0;
  let omittedCodePoints = 0;
  let redacted = false;
  let consumed = 0;
  const totalLimit = S2_DIAGNOSTIC_MAX_TOTAL_CODE_POINTS - S2_DIAGNOSTIC_MAX_MESSAGE_CODE_POINTS;

  for (const value of values) {
    const sanitized = sanitizeS2DiagnosticText(value, S2_DIAGNOSTIC_MAX_TEXT_CODE_POINTS);
    redacted = redacted || sanitized.redacted;
    const length = [...sanitized.text].length;
    if (output.length >= S2_DIAGNOSTIC_MAX_EVIDENCE_ENTRIES || consumed + length > totalLimit) {
      omittedEntries += 1;
      omittedCodePoints += length + sanitized.omitted_code_points;
      continue;
    }
    output.push(sanitized.text);
    consumed += length;
    omittedCodePoints += sanitized.omitted_code_points;
  }

  return {
    evidence: Object.freeze(output),
    truncation: Object.freeze({ omitted_entries: omittedEntries, omitted_code_points: omittedCodePoints }),
    redacted,
  };
}

export function buildS2CoordinationFailureDiagnostic<Code extends CoordinationFailureCode>(input: S2CoordinationFailureDiagnosticInput<Code>): S2CoordinationFailureDiagnostic<Code> {
  const message = sanitizeS2DiagnosticText(input.message, S2_DIAGNOSTIC_MAX_MESSAGE_CODE_POINTS);
  const evidence = boundedS2Evidence(input.evidence);
  return Object.freeze({
    schema_version: S2_FAILURE_DIAGNOSTIC_SCHEMA_VERSION,
    decision: decideS2CoordinationFailure(input.code),
    message: message.text,
    evidence: evidence.evidence,
    truncation: evidence.truncation,
    redacted: message.redacted || evidence.redacted,
  });
}

export function buildS2CoordinationRuntimeErrorDiagnostic(error: CoordinationRuntimeError): S2CoordinationFailureDiagnostic {
  return buildS2CoordinationFailureDiagnostic({ code: error.code, message: error.message, evidence: error.evidence });
}
