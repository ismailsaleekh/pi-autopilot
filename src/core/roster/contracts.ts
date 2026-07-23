import {
  AUTOPILOT_ROSTER_CHILD_ROLE_ORDER,
  AUTOPILOT_ROSTER_FREEZE_ID,
  AUTOPILOT_ROSTER_PROFILE_VALUES,
  AUTOPILOT_ROSTER_ROLE_ORDER,
  AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES,
} from '../contracts/types.ts';
import type {
  AutopilotRosterContractBySchemaVersion,
  AutopilotRosterContractSchemaVersion,
} from '../contracts/types.ts';
import {
  canonicalRosterJson,
  parseRosterJsonWithDuplicateKeyRejection,
  rosterCanonicalSha256,
  rosterCanonicalSha256Hex,
  rosterCanonicalSha256OmittingOwnField,
  type RosterSha256Digest,
} from './canonical.ts';

function deepFreezeRosterAuthority<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreezeRosterAuthority((objectValue as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(objectValue) as T;
}

deepFreezeRosterAuthority(AUTOPILOT_ROSTER_CHILD_ROLE_ORDER);
deepFreezeRosterAuthority(AUTOPILOT_ROSTER_PROFILE_VALUES);
deepFreezeRosterAuthority(AUTOPILOT_ROSTER_ROLE_ORDER);
deepFreezeRosterAuthority(AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES);

export {
  AUTOPILOT_ROSTER_CHILD_ROLE_ORDER,
  AUTOPILOT_ROSTER_FREEZE_ID,
  AUTOPILOT_ROSTER_PROFILE_VALUES,
  AUTOPILOT_ROSTER_ROLE_ORDER,
  AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES,
} from '../contracts/types.ts';
export type {
  AutopilotRosterContract,
  AutopilotRosterContractBySchemaVersion,
  AutopilotRosterContractSchemaVersion,
} from '../contracts/types.ts';

export const AUTOPILOT_ROSTER_SCHEMA_ID_BASE = 'urn:pi-autopilot:schemas:roster' as const;
export const AUTOPILOT_ROSTER_PACKAGE_VERSION_TARGET = '1.3.0' as const;
export const AUTOPILOT_ROSTER_PI_CONTRACT_BASELINE = '0.80.6' as const;
export const AUTOPILOT_ROSTER_DEFAULT_USER_STATE_ROOT = '~/.pi/agent/autopilot/' as const;

export type AutopilotRosterContractScalarType = 'enum' | 'string' | 'integer' | 'array' | 'boolean' | 'object';
export type AutopilotRosterContractEnumValue = string | null;
export type AutopilotRosterContractOrderedBy =
  | 'lexicographic'
  | 'lexicographic-null-first'
  | 'role_order'
  | 'candidate_sort_key'
  | 'roster_id_then_revision'
  | 'route_policy_id_then_revision'
  | 'recipe_id_then_recipe_revision'
  | 'evidence_id'
  | 'code';

export interface AutopilotRosterContractFieldDefinition {
  readonly type: AutopilotRosterContractScalarType;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly values?: readonly AutopilotRosterContractEnumValue[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: AutopilotRosterContractFieldDefinition;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly uniqueBy?: string;
  readonly orderedBy?: AutopilotRosterContractOrderedBy | string;
  readonly ref?: AutopilotRosterContractSchemaVersion;
  readonly format?: 'utc-ms-z' | string;
  readonly relation?: string;
  readonly note?: string;
}

export interface AutopilotRosterContractSchemaDefinition {
  readonly closed: true;
  readonly field_order: readonly string[];
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly fields: Readonly<Record<string, AutopilotRosterContractFieldDefinition>>;
  readonly hash_field?: string;
  readonly semantic_rules: readonly string[];
}

export type AutopilotRosterContractSchemaCatalog = Readonly<
  Record<AutopilotRosterContractSchemaVersion, AutopilotRosterContractSchemaDefinition>
>;

export type AutopilotRosterJsonSchema = Readonly<Record<string, unknown>>;

export class AutopilotRosterContractValidationError extends Error {
  public readonly schemaVersion: AutopilotRosterContractSchemaVersion;
  public readonly issues: readonly string[];

  constructor(schemaVersion: AutopilotRosterContractSchemaVersion, issues: readonly string[]) {
    super(`${schemaVersion} failed roster contract validation: ${issues.join('; ')}`);
    this.name = 'AutopilotRosterContractValidationError';
    this.schemaVersion = schemaVersion;
    this.issues = issues;
  }
}

export const AUTOPILOT_ROSTER_CONTRACT_SCHEMA_DEFINITIONS = deepFreezeRosterAuthority({
  "autopilot.assignment.v1": {
    "closed": true,
    "field_order": [
      "role",
      "provider_id",
      "model_id",
      "model",
      "api",
      "thinking",
      "service_tier",
      "cache_policy",
      "system_prompt_profile",
      "context_window",
      "max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability",
      "route_policy_id",
      "route_policy_revision",
      "billing_class",
      "billing_route_class",
      "auth_class",
      "auth_source",
      "qualification_state",
      "assignment_sha256"
    ],
    "required": [
      "role",
      "provider_id",
      "model_id",
      "model",
      "api",
      "thinking",
      "service_tier",
      "cache_policy",
      "system_prompt_profile",
      "context_window",
      "max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability",
      "route_policy_id",
      "route_policy_revision",
      "billing_class",
      "billing_route_class",
      "auth_class",
      "auth_source",
      "qualification_state",
      "assignment_sha256"
    ],
    "optional": [],
    "fields": {
      "role": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "parent",
          "strategy",
          "implement",
          "validate",
          "fix",
          "adjudicate",
          "bughunt",
          "extract"
        ]
      },
      "provider_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "model_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "model": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$",
        "relation": "provider_id + \"/\" + model_id"
      },
      "api": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "openai-codex-responses",
          "anthropic-messages",
          "openai-completions"
        ]
      },
      "thinking": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "high",
          "xhigh"
        ]
      },
      "service_tier": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          null,
          "priority"
        ]
      },
      "cache_policy": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "provider-default",
          "none",
          "short",
          "long"
        ]
      },
      "system_prompt_profile": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "pi-default.v1",
          "anthropic-autopilot-sanitized.v1"
        ]
      },
      "context_window": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1,
        "maximum": 10000000
      },
      "max_output_tokens": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1,
        "maximum": 1000000
      },
      "input_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "output_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "reasoning_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "reasoning-supported",
          "reasoning-unsupported"
        ]
      },
      "tool_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "tool-use-supported",
          "tool-use-unsupported"
        ]
      },
      "route_policy_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$",
        "minLength": 4,
        "maxLength": 80
      },
      "route_policy_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "billing_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "plan-backed-subscription",
          "plan-token",
          "metered-third-party-blocked",
          "forbidden-metered-gateway",
          "unknown"
        ]
      },
      "billing_route_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "subscription-oauth",
          "plan-api-token",
          "third-party-metered-blocked",
          "gateway-forbidden"
        ]
      },
      "auth_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "oauth",
          "api-key-plan-token",
          "api-key",
          "none",
          "unknown"
        ]
      },
      "auth_source": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "stored",
          "runtime",
          "environment",
          "not-configured",
          "unknown"
        ]
      },
      "qualification_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "unqualified-non-certifying-seed",
          "qualification-required",
          "synthetic-test-ready",
          "w4-certified-ready",
          "blocked-live-certification"
        ]
      },
      "assignment_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "assignment_sha256",
    "semantic_rules": [
      "assignment_sha256 hashes the assignment object omitting only assignment_sha256",
      "assignments are exactly ROLE_ORDER in rosters; duplicate/missing/extra roles reject",
      "model equals provider_id/model_id",
      "route_policy_id/revision must directly reference an existing seed route policy and provider/api must conform",
      "thinking clamping and runtime fallback are forbidden"
    ]
  },
  "autopilot.auth_summary.v1": {
    "closed": true,
    "field_order": [
      "auth_classes",
      "auth_sources",
      "secret_fields_present"
    ],
    "required": [
      "auth_classes",
      "auth_sources",
      "secret_fields_present"
    ],
    "optional": [],
    "fields": {
      "auth_classes": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "oauth",
            "api-key-plan-token",
            "api-key",
            "none",
            "unknown"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "auth_sources": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "stored",
            "runtime",
            "environment",
            "not-configured",
            "unknown"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "secret_fields_present": {
        "type": "boolean",
        "required": true,
        "nullable": false
      }
    },
    "semantic_rules": [
      "secret_fields_present must be false for every persisted roster/receipt/diagnostic"
    ]
  },
  "autopilot.billing_summary.v1": {
    "closed": true,
    "field_order": [
      "billing_class",
      "billing_route_class",
      "route_policy_ids",
      "service_tiers"
    ],
    "required": [
      "billing_class",
      "billing_route_class",
      "route_policy_ids",
      "service_tiers"
    ],
    "optional": [],
    "fields": {
      "billing_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "plan-backed-subscription",
          "plan-token",
          "metered-third-party-blocked",
          "forbidden-metered-gateway",
          "unknown"
        ]
      },
      "billing_route_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "subscription-oauth",
          "plan-api-token",
          "third-party-metered-blocked",
          "gateway-forbidden"
        ]
      },
      "route_policy_ids": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$"
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "service_tiers": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": true,
          "values": [
            null,
            "priority"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic-null-first"
      }
    },
    "semantic_rules": [
      "billing_class and billing_route_class are copied from the exact referenced route policy; credential shape is not billing authority"
    ]
  },
  "autopilot.capability_summary.v1": {
    "closed": true,
    "field_order": [
      "min_context_window",
      "min_max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability"
    ],
    "required": [
      "min_context_window",
      "min_max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability"
    ],
    "optional": [],
    "fields": {
      "min_context_window": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1,
        "maximum": 10000000
      },
      "min_max_output_tokens": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1,
        "maximum": 1000000
      },
      "input_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "output_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "reasoning_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "reasoning-supported",
          "reasoning-unsupported"
        ]
      },
      "tool_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "tool-use-supported",
          "tool-use-unsupported"
        ]
      }
    },
    "semantic_rules": [
      "summary values are derived from the exact role assignments and are not fallback authority"
    ]
  },
  "autopilot.certification_manifest.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "manifest_id",
      "manifest_revision",
      "subject_kind",
      "subject_id",
      "subject_sha256",
      "package_version",
      "pi_version",
      "qualification_state",
      "role_results",
      "required_evidence",
      "live_evidence",
      "issued_at",
      "expires_at",
      "manifest_sha256"
    ],
    "required": [
      "schema_version",
      "manifest_id",
      "manifest_revision",
      "subject_kind",
      "subject_id",
      "subject_sha256",
      "package_version",
      "pi_version",
      "qualification_state",
      "role_results",
      "required_evidence",
      "live_evidence",
      "issued_at",
      "expires_at",
      "manifest_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.certification_manifest.v1"
        ]
      },
      "manifest_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "manifest_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "subject_kind": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "provider_recipe",
          "custom_roster",
          "route_policy"
        ]
      },
      "subject_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 120
      },
      "subject_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "package_version": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$"
      },
      "pi_version": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$"
      },
      "qualification_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "unqualified-non-certifying-seed",
          "qualification-required",
          "synthetic-test-ready",
          "w4-certified-ready",
          "blocked-live-certification"
        ]
      },
      "role_results": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.certification_role_result.v1"
        },
        "minItems": 8,
        "maxItems": 8,
        "uniqueBy": "role",
        "orderedBy": "role_order"
      },
      "required_evidence": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.evidence_ref.v1"
        },
        "minItems": 1,
        "uniqueBy": "evidence_id",
        "orderedBy": "evidence_id"
      },
      "live_evidence": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.evidence_ref.v1"
        },
        "minItems": 0,
        "uniqueBy": "evidence_id",
        "orderedBy": "evidence_id"
      },
      "issued_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "expires_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "manifest_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "manifest_sha256",
    "semantic_rules": [
      "manifest_sha256 omits only itself",
      "W0 artifacts contain no certifying manifests; synthetic-test-ready is accepted only by fixtures",
      "expires_at must be after issued_at"
    ]
  },
  "autopilot.certification_role_result.v1": {
    "closed": true,
    "field_order": [
      "role",
      "state",
      "evidence_refs"
    ],
    "required": [
      "role",
      "state",
      "evidence_refs"
    ],
    "optional": [],
    "fields": {
      "role": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "parent",
          "strategy",
          "implement",
          "validate",
          "fix",
          "adjudicate",
          "bughunt",
          "extract"
        ]
      },
      "state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "pass",
          "fail",
          "synthetic-pass"
        ]
      },
      "evidence_refs": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.evidence_ref.v1"
        },
        "minItems": 1,
        "uniqueBy": "evidence_id",
        "orderedBy": "evidence_id"
      }
    },
    "semantic_rules": [
      "W0 seed candidates cannot use pass for launch readiness; only fixture contexts may use synthetic-pass"
    ]
  },
  "autopilot.context_ref.v2": {
    "closed": true,
    "field_order": [
      "path",
      "purpose",
      "sha256",
      "byte_count"
    ],
    "required": [
      "path",
      "purpose",
      "sha256",
      "byte_count"
    ],
    "optional": [],
    "fields": {
      "path": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      },
      "purpose": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 1000
      },
      "sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "byte_count": {
        "type": "integer",
        "required": true,
        "nullable": true,
        "minimum": 0
      }
    },
    "semantic_rules": [
      "closed v2 composition preserves v1 ContextRef semantics while requiring explicit null for absent optional values"
    ]
  },
  "autopilot.evidence_ref.v1": {
    "closed": true,
    "field_order": [
      "evidence_id",
      "kind",
      "uri",
      "sha256",
      "byte_count",
      "secret_free"
    ],
    "required": [
      "evidence_id",
      "kind",
      "uri",
      "sha256",
      "byte_count",
      "secret_free"
    ],
    "optional": [],
    "fields": {
      "evidence_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "kind": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "route-proof",
          "billing-proof",
          "prompt-proof",
          "cache-proof",
          "execution-proof",
          "synthetic-fixture"
        ]
      },
      "uri": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 1024
      },
      "sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "byte_count": {
        "type": "integer",
        "required": true,
        "nullable": true,
        "minimum": 0
      },
      "secret_free": {
        "type": "boolean",
        "required": true,
        "nullable": false
      }
    },
    "semantic_rules": [
      "evidence refs never contain credentials or prompt bodies"
    ]
  },
  "autopilot.existing_run_resolution_request.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "repo_id",
      "workstream_run",
      "scope",
      "selection_sha256",
      "runtime_mirror_sha256",
      "current_default_roster_id",
      "current_default_roster_revision",
      "current_default_roster_sha256",
      "roster_file_state",
      "request_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "repo_id",
      "workstream_run",
      "scope",
      "selection_sha256",
      "runtime_mirror_sha256",
      "current_default_roster_id",
      "current_default_roster_revision",
      "current_default_roster_sha256",
      "roster_file_state",
      "request_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.existing_run_resolution_request.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "resolve-existing-run"
        ]
      },
      "repo_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "workstream_run": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "selection_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "runtime_mirror_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "current_default_roster_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "current_default_roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": true,
        "minimum": 1
      },
      "current_default_roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "roster_file_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "present",
          "missing",
          "hash-mismatch"
        ]
      },
      "request_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "request_sha256",
    "semantic_rules": [
      "existing-run resolution reads only the immutable selection_sha256 and byte-equal runtime mirror; current defaults are diagnostic inputs with no selection authority",
      "missing or hash-mismatched pinned roster bytes fail closed with transition-required diagnostics and no fallback"
    ]
  },
  "autopilot.existing_run_resolution_result.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "ok",
      "status",
      "selected_scope",
      "selected_roster_id",
      "selected_roster_revision",
      "selected_roster_sha256",
      "assignment_set_sha256",
      "selection_sha256",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "ok",
      "status",
      "selected_scope",
      "selected_roster_id",
      "selected_roster_revision",
      "selected_roster_sha256",
      "assignment_set_sha256",
      "selection_sha256",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.existing_run_resolution_result.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "resolve-existing-run"
        ]
      },
      "ok": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "status": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "inspected",
          "blocked",
          "failed"
        ]
      },
      "selected_scope": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "selected_roster_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "selected_roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": true,
        "minimum": 1
      },
      "selected_roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "assignment_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "selection_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "diagnostics": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_diagnostic.v1"
        },
        "minItems": 0,
        "uniqueBy": "code",
        "orderedBy": "code"
      },
      "write_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "lock_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "files_touched": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "result_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "result_sha256",
    "semantic_rules": [
      "ok results expose the exact roster tuple from the immutable selection; blocked results expose null selected tuple fields",
      "resolve-existing-run is zero-write and zero-lock; write_count, lock_count, and files_touched must all be zero/empty"
    ]
  },
  "autopilot.historical_fixed_roster_adapter_admission.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "admitted",
      "reason",
      "unit_schema_version",
      "receipt_schema_version",
      "package_version_upper_bound_exclusive",
      "historical_unit_spec_sha256",
      "historical_receipt_sha256",
      "pre_run_selection_absent",
      "fixed_roster_chain_id",
      "roles",
      "no_conflicting_evidence",
      "historical_bytes_mutated",
      "admission_sha256"
    ],
    "required": [
      "schema_version",
      "admitted",
      "reason",
      "unit_schema_version",
      "receipt_schema_version",
      "package_version_upper_bound_exclusive",
      "historical_unit_spec_sha256",
      "historical_receipt_sha256",
      "pre_run_selection_absent",
      "fixed_roster_chain_id",
      "roles",
      "no_conflicting_evidence",
      "historical_bytes_mutated",
      "admission_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.historical_fixed_roster_adapter_admission.v1"
        ]
      },
      "admitted": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "reason": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "admitted",
          "historical-version-unsupported",
          "pre-run-selection-present",
          "fixed-roster-mismatch",
          "conflicting-evidence",
          "proof-required"
        ]
      },
      "unit_schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.unit_spec.v1"
        ]
      },
      "receipt_schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.receipt.v1"
        ]
      },
      "package_version_upper_bound_exclusive": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "1.3.0"
        ]
      },
      "historical_unit_spec_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "historical_receipt_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "pre_run_selection_absent": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "fixed_roster_chain_id": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "openai-codex-sol-terra-luna-v1"
        ]
      },
      "roles": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.historical_fixed_roster_role.v1"
        },
        "minItems": 8,
        "maxItems": 8,
        "uniqueBy": "role",
        "orderedBy": "role_order"
      },
      "no_conflicting_evidence": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "historical_bytes_mutated": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "admission_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "admission_sha256",
    "semantic_rules": [
      "admitted=true requires proven pre-1.3.0 autopilot.unit_spec.v1 plus autopilot.receipt.v1 bytes, receipt.unit_spec_sha256 equal to the unit bytes, absent pre-run selection, exact Sol/Terra/Luna role/model/thinking chain, no conflicting evidence, and historical_bytes_mutated=false",
      "any missing proof, package_version >= 1.3.0, non-v1 schema, present selection, chain mismatch, conflicting evidence, digest mismatch, or byte mutation sets admitted=false and fail-closed reason"
    ]
  },
  "autopilot.historical_fixed_roster_adapter_request.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "repo_id",
      "workstream_run",
      "scope",
      "historical_unit_spec_bytes_utf8",
      "historical_unit_spec_sha256",
      "historical_receipt_bytes_utf8",
      "historical_receipt_sha256",
      "pre_run_selection_state",
      "pre_run_selection_sha256",
      "conflicting_evidence_sha256s",
      "requested_at",
      "request_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "repo_id",
      "workstream_run",
      "scope",
      "historical_unit_spec_bytes_utf8",
      "historical_unit_spec_sha256",
      "historical_receipt_bytes_utf8",
      "historical_receipt_sha256",
      "pre_run_selection_state",
      "pre_run_selection_sha256",
      "conflicting_evidence_sha256s",
      "requested_at",
      "request_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.historical_fixed_roster_adapter_request.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "historical-adapter"
        ]
      },
      "repo_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "workstream_run": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "historical_unit_spec_bytes_utf8": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 2,
        "maxLength": 65536
      },
      "historical_unit_spec_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "historical_receipt_bytes_utf8": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 2,
        "maxLength": 65536
      },
      "historical_receipt_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "pre_run_selection_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "absent",
          "present-byte-equal",
          "present-conflicting"
        ]
      },
      "pre_run_selection_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "conflicting_evidence_sha256s": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "pattern": "^sha256:[a-f0-9]{64}$",
          "minLength": 71,
          "maxLength": 71
        },
        "minItems": 0,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "requested_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
        "minLength": 1,
        "maxLength": 4096,
        "format": "utc-ms-z"
      },
      "request_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "request_sha256",
    "semantic_rules": [
      "historical bytes are supplied byte-for-byte as UTF-8 strings; sha256 fields must match those exact bytes before JSON parse",
      "pre_run_selection_state must be absent with pre_run_selection_sha256 null for admission; any present selection fails closed"
    ]
  },
  "autopilot.historical_fixed_roster_adapter_result.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "ok",
      "status",
      "admission",
      "selected_scope",
      "selected_roster_id",
      "selected_roster_revision",
      "selected_roster_sha256",
      "assignment_set_sha256",
      "selection_identity_sha256",
      "historical_unit_spec_sha256",
      "historical_receipt_sha256",
      "historical_bytes_mutated",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "ok",
      "status",
      "admission",
      "selected_scope",
      "selected_roster_id",
      "selected_roster_revision",
      "selected_roster_sha256",
      "assignment_set_sha256",
      "selection_identity_sha256",
      "historical_unit_spec_sha256",
      "historical_receipt_sha256",
      "historical_bytes_mutated",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.historical_fixed_roster_adapter_result.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "historical-adapter"
        ]
      },
      "ok": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "status": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "inspected",
          "blocked",
          "failed"
        ]
      },
      "admission": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.historical_fixed_roster_adapter_admission.v1"
      },
      "selected_scope": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "selected_roster_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "selected_roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": true,
        "minimum": 1
      },
      "selected_roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "assignment_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "selection_identity_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "historical_unit_spec_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "historical_receipt_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "historical_bytes_mutated": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "diagnostics": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_diagnostic.v1"
        },
        "minItems": 0,
        "uniqueBy": "code",
        "orderedBy": "code"
      },
      "write_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "lock_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "files_touched": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "result_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "result_sha256",
    "semantic_rules": [
      "accepted results expose the exact immutable selection identity tuple and selection_identity_sha256 preimage; rejected results expose null selection fields",
      "historical adapter never writes, locks, or mutates historical bytes; all failures are fail closed with zero write_count and lock_count"
    ]
  },
  "autopilot.historical_fixed_roster_artifact.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "artifact_id",
      "artifact_kind",
      "bytes_utf8",
      "bytes_sha256",
      "parsed_schema_version",
      "package_version",
      "artifact_sha256"
    ],
    "required": [
      "schema_version",
      "artifact_id",
      "artifact_kind",
      "bytes_utf8",
      "bytes_sha256",
      "parsed_schema_version",
      "package_version",
      "artifact_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.historical_fixed_roster_artifact.v1"
        ]
      },
      "artifact_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "artifact_kind": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "unit-spec",
          "receipt"
        ]
      },
      "bytes_utf8": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 2,
        "maxLength": 65536
      },
      "bytes_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "parsed_schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.unit_spec.v1",
          "autopilot.receipt.v1"
        ]
      },
      "package_version": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
        "minLength": 5,
        "maxLength": 20
      },
      "artifact_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "artifact_sha256",
    "semantic_rules": [
      "bytes_sha256 is SHA-256 of the exact UTF-8 bytes in bytes_utf8 before JSON parsing or canonicalization",
      "artifact_sha256 hashes this artifact object omitting only artifact_sha256 and never replaces historical bytes with canonical bytes"
    ]
  },
  "autopilot.historical_fixed_roster_role.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "role",
      "provider_id",
      "model_id",
      "model",
      "api",
      "thinking"
    ],
    "required": [
      "schema_version",
      "role",
      "provider_id",
      "model_id",
      "model",
      "api",
      "thinking"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.historical_fixed_roster_role.v1"
        ]
      },
      "role": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "parent",
          "strategy",
          "implement",
          "validate",
          "fix",
          "adjudicate",
          "bughunt",
          "extract"
        ]
      },
      "provider_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "model_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "model": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$",
        "minLength": 1,
        "maxLength": 185,
        "relation": "provider_id + \"/\" + model_id"
      },
      "api": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "openai-codex-responses",
          "anthropic-messages",
          "openai-completions"
        ]
      },
      "thinking": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "high",
          "xhigh"
        ]
      }
    },
    "semantic_rules": [
      "historical fixed-roster roles are ROLE_ORDER and are compared by exact provider_id/model_id/model/api/thinking bytes parsed from v1 evidence",
      "the only admitted Phase 37 historical chain is openai-codex Sol xhigh for parent/strategy/validate/adjudicate/bughunt, Terra high for implement/fix, and Luna high for extract"
    ]
  },
  "autopilot.inventory_model.v1": {
    "closed": true,
    "field_order": [
      "model_id",
      "api",
      "context_window",
      "max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability",
      "thinking_values",
      "service_tiers",
      "cache_policies",
      "system_prompt_profiles"
    ],
    "required": [
      "model_id",
      "api",
      "context_window",
      "max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability",
      "thinking_values",
      "service_tiers",
      "cache_policies",
      "system_prompt_profiles"
    ],
    "optional": [],
    "fields": {
      "model_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 120
      },
      "api": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "openai-codex-responses",
          "anthropic-messages",
          "openai-completions"
        ]
      },
      "context_window": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "max_output_tokens": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "input_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "output_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "reasoning_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "reasoning-supported",
          "reasoning-unsupported"
        ]
      },
      "tool_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "tool-use-supported",
          "tool-use-unsupported"
        ]
      },
      "thinking_values": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "high",
            "xhigh"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "service_tiers": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": true,
          "values": [
            null,
            "priority"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic-null-first"
      },
      "cache_policies": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "provider-default",
            "none",
            "short",
            "long"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "system_prompt_profiles": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "pi-default.v1",
            "anthropic-autopilot-sanitized.v1"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      }
    },
    "semantic_rules": [
      "inventory model facts are non-secret registry capability facts only"
    ]
  },
  "autopilot.inventory_provider.v1": {
    "closed": true,
    "field_order": [
      "provider_id",
      "auth_configured",
      "auth_class",
      "auth_source",
      "auth_status",
      "is_using_oauth",
      "billing_route_class",
      "models"
    ],
    "required": [
      "provider_id",
      "auth_configured",
      "auth_class",
      "auth_source",
      "auth_status",
      "is_using_oauth",
      "billing_route_class",
      "models"
    ],
    "optional": [],
    "fields": {
      "provider_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "auth_configured": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "auth_class": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          "oauth",
          "api-key-plan-token",
          "api-key",
          null
        ]
      },
      "auth_source": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          "stored",
          "runtime",
          "environment",
          "not-configured",
          null
        ]
      },
      "auth_status": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "configured",
          "missing",
          "forbidden",
          "unknown"
        ]
      },
      "is_using_oauth": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "billing_route_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "subscription-oauth",
          "plan-api-token",
          "third-party-metered-blocked",
          "gateway-forbidden",
          "unknown"
        ]
      },
      "models": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.inventory_model.v1"
        },
        "minItems": 0,
        "uniqueBy": "model_id+api",
        "orderedBy": "model_id,api"
      }
    },
    "semantic_rules": [
      "hasConfiguredAuth/getProviderAuthStatus/isUsingOAuth are the only auth facts; no credential resolution occurs during inspection"
    ]
  },
  "autopilot.observed_profile.v1": {
    "closed": true,
    "field_order": [
      "provider_id",
      "requested_model_id",
      "executed_model_id",
      "api",
      "thinking",
      "service_tier",
      "cache_policy",
      "system_prompt_profile",
      "system_prompt_sha256",
      "route_policy_id",
      "route_policy_revision",
      "request_profile_sha256",
      "observed_profile_sha256"
    ],
    "required": [
      "provider_id",
      "requested_model_id",
      "executed_model_id",
      "api",
      "thinking",
      "service_tier",
      "cache_policy",
      "system_prompt_profile",
      "system_prompt_sha256",
      "route_policy_id",
      "route_policy_revision",
      "request_profile_sha256",
      "observed_profile_sha256"
    ],
    "optional": [],
    "fields": {
      "provider_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "requested_model_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 120
      },
      "executed_model_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 120
      },
      "api": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "openai-codex-responses",
          "anthropic-messages",
          "openai-completions"
        ]
      },
      "thinking": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "high",
          "xhigh"
        ]
      },
      "service_tier": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          null,
          "priority"
        ]
      },
      "cache_policy": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "provider-default",
          "none",
          "short",
          "long"
        ]
      },
      "system_prompt_profile": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "pi-default.v1",
          "anthropic-autopilot-sanitized.v1"
        ]
      },
      "system_prompt_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "route_policy_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$"
      },
      "route_policy_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "request_profile_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "observed_profile_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "observed_profile_sha256",
    "semantic_rules": [
      "observed_profile_sha256 omits only itself",
      "provider/model/api/thinking/service/cache/prompt/route mismatch is terminal acceptance failure",
      "prompts and credentials are never stored, only prompt hash/profile identity"
    ]
  },
  "autopilot.pre_run_selection.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "repo_id",
      "workstream_run",
      "scope",
      "roster_id",
      "roster_revision",
      "roster_sha256",
      "assignment_set_sha256",
      "config_sha256",
      "selected_at",
      "selection_sha256"
    ],
    "required": [
      "schema_version",
      "repo_id",
      "workstream_run",
      "scope",
      "roster_id",
      "roster_revision",
      "roster_sha256",
      "assignment_set_sha256",
      "config_sha256",
      "selected_at",
      "selection_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.pre_run_selection.v1"
        ]
      },
      "repo_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "workstream_run": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "roster_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "assignment_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "config_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "selected_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "selection_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "selection_sha256",
    "semantic_rules": [
      "pre-run selection path is create-only under <state_root>/roster-selections/<repo-id>/<workstream-run>.json",
      "byte-identical collision is idempotent; different bytes reject before worktree mutation or spend",
      "runtime mirror must be exact byte/hash equal to pre-run selection"
    ]
  },
  "autopilot.pre_run_selection_publish_request.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "selection",
      "selection_path",
      "existing_selection_sha256",
      "request_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "selection",
      "selection_path",
      "existing_selection_sha256",
      "request_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.pre_run_selection_publish_request.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "publish-pre-run-selection"
        ]
      },
      "selection": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.pre_run_selection.v1"
      },
      "selection_path": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      },
      "existing_selection_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "request_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "request_sha256",
    "semantic_rules": [
      "publish-pre-run-selection is a create-only interface over the exact selection bytes before worktree mutation or spend",
      "byte-identical existing_selection_sha256 is idempotent replay; different existing bytes fail closed and preserve existing bytes"
    ]
  },
  "autopilot.pre_run_selection_publish_result.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "ok",
      "status",
      "selection_sha256",
      "idempotent_replay",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "ok",
      "status",
      "selection_sha256",
      "idempotent_replay",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.pre_run_selection_publish_result.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "publish-pre-run-selection"
        ]
      },
      "ok": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "status": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "published",
          "inspected",
          "blocked",
          "failed"
        ]
      },
      "selection_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "idempotent_replay": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "diagnostics": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_diagnostic.v1"
        },
        "minItems": 0,
        "uniqueBy": "code",
        "orderedBy": "code"
      },
      "write_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "lock_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "files_touched": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "result_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "result_sha256",
    "semantic_rules": [
      "new publish success counts exactly one visible selection JSON authority write; temp files, fsyncs, and locks are not write_count",
      "idempotent replay and create-only conflict perform no visible writes and leave files_touched empty unless a new selection is actually published"
    ]
  },
  "autopilot.profile_template.v1": {
    "closed": true,
    "field_order": [
      "profile_id",
      "selected_by_default",
      "route_policy_id",
      "route_policy_revision",
      "role_templates"
    ],
    "required": [
      "profile_id",
      "selected_by_default",
      "route_policy_id",
      "route_policy_revision",
      "role_templates"
    ],
    "optional": [],
    "fields": {
      "profile_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,31}$",
        "minLength": 1,
        "maxLength": 32
      },
      "selected_by_default": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "route_policy_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$"
      },
      "route_policy_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "role_templates": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.role_template.v1"
        },
        "minItems": 8,
        "maxItems": 8,
        "uniqueBy": "role",
        "orderedBy": "role_order"
      }
    },
    "semantic_rules": [
      "profile_id must be one of the frozen public profiles",
      "role_templates must cover ROLE_ORDER exactly"
    ]
  },
  "autopilot.provider_recipe.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "recipe_id",
      "recipe_revision",
      "provider_family",
      "route_policy_id",
      "route_policy_revision",
      "profile_templates",
      "minimum_pi_version",
      "certification_manifest_id",
      "certification_manifest_sha256",
      "qualification_state",
      "recipe_state",
      "non_certifying_seed",
      "recipe_sha256"
    ],
    "required": [
      "schema_version",
      "recipe_id",
      "recipe_revision",
      "provider_family",
      "route_policy_id",
      "route_policy_revision",
      "profile_templates",
      "minimum_pi_version",
      "certification_manifest_id",
      "certification_manifest_sha256",
      "qualification_state",
      "recipe_state",
      "non_certifying_seed",
      "recipe_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.provider_recipe.v1"
        ]
      },
      "recipe_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "recipe_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "provider_family": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "route_policy_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$"
      },
      "route_policy_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "profile_templates": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.profile_template.v1"
        },
        "minItems": 1,
        "maxItems": 3,
        "uniqueBy": "profile_id",
        "orderedBy": "profile_id"
      },
      "minimum_pi_version": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$"
      },
      "certification_manifest_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "minLength": 1,
        "maxLength": 120
      },
      "certification_manifest_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "qualification_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "unqualified-non-certifying-seed",
          "qualification-required",
          "synthetic-test-ready",
          "w4-certified-ready",
          "blocked-live-certification"
        ]
      },
      "recipe_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "unqualified-seed",
          "blocked-live-certification",
          "synthetic-fixture-ready",
          "w4-certified-ready"
        ]
      },
      "non_certifying_seed": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "recipe_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "recipe_sha256",
    "semantic_rules": [
      "recipe_sha256 omits only recipe_sha256",
      "route_policy_id/revision is direct and required; deriveProviderFromRecipe is forbidden",
      "certification_manifest_* are null until W4 certification or synthetic fixture context"
    ]
  },
  "autopilot.receipt.v2": {
    "closed": true,
    "field_order": [
      "schema_version",
      "tool_name",
      "workstream",
      "unit_id",
      "role",
      "attempt",
      "emitted_at",
      "status_output",
      "status_sha256",
      "schema_sha256",
      "tool_call_id",
      "provider_identity",
      "expected_identity_hash",
      "roster_id",
      "roster_revision",
      "roster_sha256",
      "assignment_sha256",
      "pre_run_selection_sha256",
      "request_profile",
      "observed_profile"
    ],
    "required": [
      "schema_version",
      "tool_name",
      "workstream",
      "unit_id",
      "role",
      "attempt",
      "emitted_at",
      "status_output",
      "status_sha256",
      "schema_sha256",
      "tool_call_id",
      "provider_identity",
      "expected_identity_hash",
      "roster_id",
      "roster_revision",
      "roster_sha256",
      "assignment_sha256",
      "pre_run_selection_sha256",
      "request_profile",
      "observed_profile"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.receipt.v2"
        ]
      },
      "tool_name": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot_emit_status"
        ]
      },
      "workstream": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "unit_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "role": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "strategy",
          "implement",
          "validate",
          "fix",
          "adjudicate",
          "bughunt",
          "extract"
        ]
      },
      "attempt": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "emitted_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "status_output": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      },
      "status_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "schema_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "tool_call_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 200
      },
      "provider_identity": {
        "type": "object",
        "required": true,
        "nullable": false,
        "note": "v1 provider_identity object preserved by source pin and compared to observed_profile"
      },
      "expected_identity_hash": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "roster_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "assignment_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "pre_run_selection_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "request_profile": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.request_profile.v1"
      },
      "observed_profile": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.observed_profile.v1"
      }
    },
    "semantic_rules": [
      "receipt.v2 is a closed composition pinned to current v1 source hashes",
      "terminal acceptance fails on requested/executed provider/model/api/thinking/service/cache/prompt/route mismatch",
      "v1 receipts remain immutable historical evidence and are never reinterpreted as v2"
    ]
  },
  "autopilot.receipt_validation_request.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "requested_profile_sha256",
      "observed_request_profile_sha256",
      "requested_model_id",
      "executed_model_id",
      "requested_thinking",
      "observed_thinking",
      "request_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "requested_profile_sha256",
      "observed_request_profile_sha256",
      "requested_model_id",
      "executed_model_id",
      "requested_thinking",
      "observed_thinking",
      "request_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.receipt_validation_request.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "validate-receipt"
        ]
      },
      "requested_profile_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "observed_request_profile_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "requested_model_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "minLength": 1,
        "maxLength": 120
      },
      "executed_model_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "minLength": 1,
        "maxLength": 120
      },
      "requested_thinking": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          "high",
          "xhigh"
        ]
      },
      "observed_thinking": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          "high",
          "xhigh"
        ]
      },
      "request_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "request_sha256",
    "semantic_rules": [
      "validate-receipt compares requested profile hash, model, and thinking facts exactly to observed receipt facts",
      "missing comparison facts fail closed rather than falling back to provider/model defaults"
    ]
  },
  "autopilot.receipt_validation_result.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "ok",
      "status",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "ok",
      "status",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.receipt_validation_result.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "validate-receipt"
        ]
      },
      "ok": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "status": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "inspected",
          "blocked",
          "failed"
        ]
      },
      "diagnostics": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_diagnostic.v1"
        },
        "minItems": 0,
        "uniqueBy": "code",
        "orderedBy": "code"
      },
      "write_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "lock_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "files_touched": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "result_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "result_sha256",
    "semantic_rules": [
      "validate-receipt is zero-write and zero-lock; mismatches are terminal acceptance failures",
      "the result contains only secret-free diagnostics and a deterministic result_sha256"
    ]
  },
  "autopilot.recipe_resolution_request.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "profile_id",
      "recipe_id",
      "recipe_revision",
      "inventory_sha256"
    ],
    "required": [
      "schema_version",
      "profile_id",
      "recipe_id",
      "recipe_revision",
      "inventory_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.recipe_resolution_request.v1"
        ]
      },
      "profile_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,31}$",
        "minLength": 1,
        "maxLength": 32
      },
      "recipe_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "recipe_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "inventory_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "semantic_rules": [
      "recipe_id/revision is supplied explicitly; deriveProviderFromRecipe is forbidden"
    ]
  },
  "autopilot.recipe_resolution_result.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "resolved",
      "candidate",
      "diagnostics",
      "result_sha256"
    ],
    "required": [
      "schema_version",
      "resolved",
      "candidate",
      "diagnostics",
      "result_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.recipe_resolution_result.v1"
        ]
      },
      "resolved": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "candidate": {
        "type": "object",
        "required": true,
        "nullable": true,
        "ref": "autopilot.roster_candidate.v1"
      },
      "diagnostics": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_diagnostic.v1"
        },
        "minItems": 0,
        "uniqueBy": "code",
        "orderedBy": "code"
      },
      "result_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "result_sha256",
    "semantic_rules": [
      "candidate direct route and recipe references must match registry entries exactly"
    ]
  },
  "autopilot.request_profile.v1": {
    "closed": true,
    "field_order": [
      "provider_id",
      "model_id",
      "model",
      "api",
      "thinking",
      "service_tier",
      "cache_policy",
      "system_prompt_profile",
      "context_window",
      "max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability",
      "route_policy_id",
      "route_policy_revision",
      "request_profile_sha256"
    ],
    "required": [
      "provider_id",
      "model_id",
      "model",
      "api",
      "thinking",
      "service_tier",
      "cache_policy",
      "system_prompt_profile",
      "context_window",
      "max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability",
      "route_policy_id",
      "route_policy_revision",
      "request_profile_sha256"
    ],
    "optional": [],
    "fields": {
      "provider_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "model_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "model": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$",
        "relation": "provider_id + \"/\" + model_id"
      },
      "api": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "openai-codex-responses",
          "anthropic-messages",
          "openai-completions"
        ]
      },
      "thinking": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "high",
          "xhigh"
        ]
      },
      "service_tier": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          null,
          "priority"
        ]
      },
      "cache_policy": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "provider-default",
          "none",
          "short",
          "long"
        ]
      },
      "system_prompt_profile": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "pi-default.v1",
          "anthropic-autopilot-sanitized.v1"
        ]
      },
      "context_window": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "max_output_tokens": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "input_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "output_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "reasoning_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "reasoning-supported",
          "reasoning-unsupported"
        ]
      },
      "tool_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "tool-use-supported",
          "tool-use-unsupported"
        ]
      },
      "route_policy_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$"
      },
      "route_policy_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "request_profile_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "request_profile_sha256",
    "semantic_rules": [
      "request_profile_sha256 omits only itself",
      "terminal acceptance compares requested facts to observed facts exactly"
    ]
  },
  "autopilot.role_template.v1": {
    "closed": true,
    "field_order": [
      "role",
      "model_id",
      "api",
      "thinking",
      "service_tier",
      "cache_policy",
      "system_prompt_profile",
      "context_window",
      "max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability"
    ],
    "required": [
      "role",
      "model_id",
      "api",
      "thinking",
      "service_tier",
      "cache_policy",
      "system_prompt_profile",
      "context_window",
      "max_output_tokens",
      "input_modalities",
      "output_modalities",
      "reasoning_capability",
      "tool_capability"
    ],
    "optional": [],
    "fields": {
      "role": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "parent",
          "strategy",
          "implement",
          "validate",
          "fix",
          "adjudicate",
          "bughunt",
          "extract"
        ]
      },
      "model_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 120
      },
      "api": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "openai-codex-responses",
          "anthropic-messages",
          "openai-completions"
        ]
      },
      "thinking": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "high",
          "xhigh"
        ]
      },
      "service_tier": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          null,
          "priority"
        ]
      },
      "cache_policy": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "provider-default",
          "none",
          "short",
          "long"
        ]
      },
      "system_prompt_profile": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "pi-default.v1",
          "anthropic-autopilot-sanitized.v1"
        ]
      },
      "context_window": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "max_output_tokens": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "input_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "output_modalities": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "text",
            "image",
            "audio",
            "file",
            "patch"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "reasoning_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "reasoning-supported",
          "reasoning-unsupported"
        ]
      },
      "tool_capability": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "tool-use-supported",
          "tool-use-unsupported"
        ]
      }
    },
    "semantic_rules": [
      "role templates are declarative recipe inputs and never infer provider from model names"
    ]
  },
  "autopilot.roster.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "roster_id",
      "roster_revision",
      "display_name",
      "scope",
      "selected_scope",
      "profile_id",
      "recipe_id",
      "recipe_revision",
      "generation_source",
      "package_version",
      "pi_version",
      "route_policy_ids",
      "assignment_set_sha256",
      "assignments",
      "capability_summary",
      "billing_summary",
      "auth_summary",
      "certification_manifest_id",
      "certification_manifest_sha256",
      "created_at",
      "roster_sha256"
    ],
    "required": [
      "schema_version",
      "roster_id",
      "roster_revision",
      "display_name",
      "scope",
      "selected_scope",
      "profile_id",
      "recipe_id",
      "recipe_revision",
      "generation_source",
      "package_version",
      "pi_version",
      "route_policy_ids",
      "assignment_set_sha256",
      "assignments",
      "capability_summary",
      "billing_summary",
      "auth_summary",
      "certification_manifest_id",
      "certification_manifest_sha256",
      "created_at",
      "roster_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster.v1"
        ]
      },
      "roster_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "display_name": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 120
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "selected_scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "profile_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,31}$",
        "minLength": 1,
        "maxLength": 32
      },
      "recipe_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "recipe_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "generation_source": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "w0-non-certifying-seed",
          "user-custom",
          "w4-certified-recipe",
          "historical-adapter"
        ]
      },
      "package_version": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$"
      },
      "pi_version": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$"
      },
      "route_policy_ids": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$"
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "assignment_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "assignments": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.assignment.v1"
        },
        "minItems": 8,
        "maxItems": 8,
        "uniqueBy": "role",
        "orderedBy": "role_order"
      },
      "capability_summary": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.capability_summary.v1"
      },
      "billing_summary": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.billing_summary.v1"
      },
      "auth_summary": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.auth_summary.v1"
      },
      "certification_manifest_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "minLength": 1,
        "maxLength": 120
      },
      "certification_manifest_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "created_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "roster_sha256",
    "semantic_rules": [
      "roster_sha256 omits only roster_sha256 and retains nested assignment hashes",
      "scope and selected_scope must match the save authority chosen by the user",
      "assignment_set_sha256 is the hash of ROLE_ORDER assignment_sha256s",
      "certification_manifest_* are null for W0 non-certifying seeds",
      "all generated roster records include context/tool/reasoning/input/output, billing route, non-secret auth, service, cache, prompt, and exact route facts"
    ]
  },
  "autopilot.roster_candidate.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "candidate_id",
      "candidate_sort_key",
      "scope",
      "profile_id",
      "recipe_id",
      "recipe_revision",
      "route_policy_id",
      "route_policy_revision",
      "roster_id",
      "roster_revision",
      "assignment_set_sha256",
      "roster_sha256",
      "candidate_state",
      "launch_readiness",
      "qualification_state",
      "non_certifying_seed",
      "synthetic_fixture_ready_only",
      "converges_with",
      "diagnostic_codes",
      "readiness_authority",
      "provider_pack_id",
      "certification_manifest_id",
      "certification_manifest_sha256",
      "recipe_sha256",
      "route_policy_sha256",
      "candidate_sha256"
    ],
    "required": [
      "schema_version",
      "candidate_id",
      "candidate_sort_key",
      "scope",
      "profile_id",
      "recipe_id",
      "recipe_revision",
      "route_policy_id",
      "route_policy_revision",
      "roster_id",
      "roster_revision",
      "assignment_set_sha256",
      "roster_sha256",
      "candidate_state",
      "launch_readiness",
      "qualification_state",
      "non_certifying_seed",
      "synthetic_fixture_ready_only",
      "converges_with",
      "diagnostic_codes",
      "candidate_sha256"
    ],
    "optional": [
      "readiness_authority",
      "provider_pack_id",
      "certification_manifest_id",
      "certification_manifest_sha256",
      "recipe_sha256",
      "route_policy_sha256"
    ],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_candidate.v1"
        ]
      },
      "candidate_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "candidate_sort_key": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 200
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "profile_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,31}$",
        "minLength": 1,
        "maxLength": 32
      },
      "recipe_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "recipe_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "route_policy_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$"
      },
      "route_policy_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "roster_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "assignment_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "candidate_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "qualification-required",
          "blocked-live-certification",
          "synthetic-fixture-ready",
          "w4-certified-ready"
        ]
      },
      "launch_readiness": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "not-ready-until-w4",
          "blocked",
          "synthetic-fixture-only",
          "w4-certified-ready"
        ]
      },
      "qualification_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "unqualified-non-certifying-seed",
          "qualification-required",
          "synthetic-test-ready",
          "w4-certified-ready",
          "blocked-live-certification"
        ]
      },
      "non_certifying_seed": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "synthetic_fixture_ready_only": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "converges_with": {
        "type": "string",
        "required": true,
        "nullable": true,
        "minLength": 1,
        "maxLength": 96
      },
      "diagnostic_codes": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "pattern": "^ROSTER_[A-Z0-9_]+$"
        },
        "minItems": 0,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "readiness_authority": {
        "type": "enum",
        "required": false,
        "nullable": true,
        "values": [
          "w4-provider-registry.v1",
          "synthetic-fixture.v1"
        ]
      },
      "provider_pack_id": {
        "type": "string",
        "required": false,
        "nullable": true,
        "minLength": 1,
        "maxLength": 120
      },
      "certification_manifest_id": {
        "type": "string",
        "required": false,
        "nullable": true,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "certification_manifest_sha256": {
        "type": "string",
        "required": false,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "recipe_sha256": {
        "type": "string",
        "required": false,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "route_policy_sha256": {
        "type": "string",
        "required": false,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "candidate_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "candidate_sha256",
    "semantic_rules": [
      "candidate links directly to recipe_id/revision and route_policy_id/revision",
      "w4-certified-ready launch_readiness is valid only with readiness_authority w4-provider-registry.v1 plus exact provider_pack_id, certification_manifest_sha256, recipe_sha256, route_policy_sha256, and roster_sha256 bindings",
      "synthetic fixture readiness is historical fixture data only and is not production launch authority",
      "candidate_sort_key orders candidate lists; duplicate keys reject"
    ]
  },
  "autopilot.roster_candidate_set.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "candidate_set_id",
      "scope",
      "inventory_sha256",
      "recipe_registry_sha256",
      "candidates",
      "recommended_profile_id",
      "created_at",
      "candidate_set_sha256"
    ],
    "required": [
      "schema_version",
      "candidate_set_id",
      "scope",
      "inventory_sha256",
      "recipe_registry_sha256",
      "candidates",
      "recommended_profile_id",
      "created_at",
      "candidate_set_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_candidate_set.v1"
        ]
      },
      "candidate_set_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "inventory_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "recipe_registry_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "candidates": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_candidate.v1"
        },
        "minItems": 0,
        "uniqueBy": "candidate_id",
        "orderedBy": "candidate_sort_key"
      },
      "recommended_profile_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,31}$",
        "minLength": 1,
        "maxLength": 32
      },
      "created_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "candidate_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "candidate_set_sha256",
    "semantic_rules": [
      "candidate_set_id derives from the preimage with candidate_set_id and candidate_set_sha256 omitted",
      "candidate_set_sha256 omits only candidate_set_sha256 after ID insertion",
      "approval binds exact candidate_set_sha256 and ordered approved roster_sha256 values; stale/reordered/partial approval rejects before lock"
    ]
  },
  "autopilot.roster_config.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "scope",
      "default_roster_id",
      "default_roster_revision",
      "default_roster_sha256",
      "rosters",
      "previous_config_sha256",
      "updated_at",
      "config_sha256"
    ],
    "required": [
      "schema_version",
      "scope",
      "default_roster_id",
      "default_roster_revision",
      "default_roster_sha256",
      "rosters",
      "previous_config_sha256",
      "updated_at",
      "config_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_config.v1"
        ]
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "default_roster_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "default_roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "default_roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "rosters": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.saved_roster_ref.v1"
        },
        "minItems": 1,
        "uniqueBy": "roster_id+revision",
        "orderedBy": "roster_id,roster_revision"
      },
      "previous_config_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "updated_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "config_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "config_sha256",
    "semantic_rules": [
      "config writes are replace-not-merge and use complete-after-state CAS over previous_config_sha256",
      "config.json is published last as sole visibility pointer",
      "readback must revalidate all roster bytes/hashes before receipt",
      "default selection is the exact tuple default_roster_id+default_roster_revision+default_roster_sha256 and never roster_id alone",
      "the default tuple must match exactly one rosters entry by roster_id, roster_revision, and roster_sha256; zero or multiple matches reject before use",
      "rosters are unique by roster_id+roster_revision; multiple revisions of the same roster_id may coexist only because the default tuple is exact and presentation order has no authority"
    ]
  },
  "autopilot.roster_diagnostic.v1": {
    "closed": true,
    "field_order": [
      "code",
      "severity",
      "message",
      "remediation",
      "secret_free"
    ],
    "required": [
      "code",
      "severity",
      "message",
      "remediation",
      "secret_free"
    ],
    "optional": [],
    "fields": {
      "code": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^ROSTER_[A-Z0-9_]+$"
      },
      "severity": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "info",
          "warning",
          "error",
          "fatal"
        ]
      },
      "message": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 2000
      },
      "remediation": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 2000
      },
      "secret_free": {
        "type": "boolean",
        "required": true,
        "nullable": false
      }
    },
    "semantic_rules": [
      "diagnostics are locked literals by code and never include credential material"
    ]
  },
  "autopilot.roster_doctor_result.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "status",
      "inventory_sha256",
      "route_results",
      "recipe_results",
      "diagnostics",
      "result_sha256"
    ],
    "required": [
      "schema_version",
      "status",
      "inventory_sha256",
      "route_results",
      "recipe_results",
      "diagnostics",
      "result_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_doctor_result.v1"
        ]
      },
      "status": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "pass",
          "warn",
          "blocked",
          "failed"
        ]
      },
      "inventory_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "route_results": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.route_resolution_result.v1"
        },
        "minItems": 0,
        "uniqueBy": "result_sha256",
        "orderedBy": "result_sha256"
      },
      "recipe_results": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.recipe_resolution_result.v1"
        },
        "minItems": 0,
        "uniqueBy": "result_sha256",
        "orderedBy": "result_sha256"
      },
      "diagnostics": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_diagnostic.v1"
        },
        "minItems": 0,
        "uniqueBy": "code",
        "orderedBy": "code"
      },
      "result_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "result_sha256",
    "semantic_rules": [
      "doctor is diagnostic-only and zero-write; blocked readiness cannot be upgraded by diagnostic text",
      "route_results are unique by result_sha256 and sorted by result_sha256 ascending before result_sha256 is computed",
      "recipe_results are unique by result_sha256 and sorted by result_sha256 ascending before result_sha256 is computed"
    ]
  },
  "autopilot.roster_inventory.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "inventory_id",
      "created_at",
      "source",
      "project_trusted",
      "providers",
      "inventory_sha256"
    ],
    "required": [
      "schema_version",
      "inventory_id",
      "created_at",
      "source",
      "project_trusted",
      "providers",
      "inventory_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_inventory.v1"
        ]
      },
      "inventory_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "created_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "source": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "ctx.modelRegistry",
          "synthetic-fixture"
        ]
      },
      "project_trusted": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "providers": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.inventory_provider.v1"
        },
        "minItems": 0,
        "uniqueBy": "provider_id",
        "orderedBy": "provider_id"
      },
      "inventory_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "inventory_sha256",
    "semantic_rules": [
      "inventory_sha256 omits only itself",
      "project trust is checked for reads and writes; untrusted project-scope reads fail closed"
    ]
  },
  "autopilot.roster_setup_receipt.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "receipt_id",
      "scope",
      "saved_rosters",
      "default_roster_id",
      "default_roster_revision",
      "default_roster_sha256",
      "approved_candidate_set_sha256",
      "approved_roster_sha256s",
      "config_sha256",
      "original_command",
      "fresh_session_required",
      "zero_secrets",
      "issued_at",
      "receipt_sha256"
    ],
    "required": [
      "schema_version",
      "receipt_id",
      "scope",
      "saved_rosters",
      "default_roster_id",
      "default_roster_revision",
      "default_roster_sha256",
      "approved_candidate_set_sha256",
      "approved_roster_sha256s",
      "config_sha256",
      "original_command",
      "fresh_session_required",
      "zero_secrets",
      "issued_at",
      "receipt_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_setup_receipt.v1"
        ]
      },
      "receipt_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "saved_rosters": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.saved_roster_ref.v1"
        },
        "minItems": 1,
        "uniqueBy": "roster_id+revision",
        "orderedBy": "roster_id,roster_revision"
      },
      "default_roster_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "default_roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "default_roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "approved_candidate_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "approved_roster_sha256s": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "pattern": "^sha256:[a-f0-9]{64}$",
          "minLength": 71,
          "maxLength": 71
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "roster_id,roster_revision presentation order"
      },
      "config_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "original_command": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      },
      "fresh_session_required": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "zero_secrets": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "issued_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "receipt_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "receipt_sha256",
    "semantic_rules": [
      "receipt emits only after readback revalidates every byte/hash",
      "fresh_session_required and zero_secrets must both be true",
      "receipt default selection is the exact tuple default_roster_id+default_roster_revision+default_roster_sha256 and never roster_id alone",
      "the receipt default tuple must match exactly one saved_rosters entry by roster_id, roster_revision, and roster_sha256; zero or multiple matches reject receipt validation",
      "saved_rosters are unique by roster_id+roster_revision and approved_roster_sha256s preserve the approved roster presentation order exactly"
    ]
  },
  "autopilot.roster_tool_request.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "scope",
      "trusted_project_root",
      "candidate_set_sha256",
      "approved_roster_sha256s",
      "default_roster_id",
      "default_roster_revision",
      "default_roster_sha256",
      "original_command"
    ],
    "required": [
      "schema_version",
      "action",
      "scope",
      "trusted_project_root",
      "candidate_set_sha256",
      "approved_roster_sha256s",
      "default_roster_id",
      "default_roster_revision",
      "default_roster_sha256",
      "original_command"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_tool_request.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "inspect",
          "propose",
          "save",
          "reject",
          "doctor"
        ]
      },
      "scope": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "user",
          "trusted-project"
        ]
      },
      "trusted_project_root": {
        "type": "string",
        "required": true,
        "nullable": true,
        "minLength": 1,
        "maxLength": 4096
      },
      "candidate_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "approved_roster_sha256s": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "pattern": "^sha256:[a-f0-9]{64}$",
          "minLength": 71,
          "maxLength": 71
        },
        "minItems": 0,
        "uniqueItems": true
      },
      "default_roster_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "default_roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": true,
        "minimum": 1
      },
      "default_roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": true,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "original_command": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      }
    },
    "semantic_rules": [
      "state roots are package-selected by constructor injection only; public setup requests cannot override storage roots",
      "inspect/propose/reject/doctor are zero persistent writes and zero locks",
      "save requests must bind default_roster_id+default_roster_revision+default_roster_sha256 to one approved roster; non-save requests carry null default tuple fields"
    ]
  },
  "autopilot.roster_tool_result.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "action",
      "ok",
      "status",
      "candidate_set",
      "receipt",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "required": [
      "schema_version",
      "action",
      "ok",
      "status",
      "candidate_set",
      "receipt",
      "diagnostics",
      "write_count",
      "lock_count",
      "files_touched",
      "result_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_tool_result.v1"
        ]
      },
      "action": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "inspect",
          "propose",
          "save",
          "reject",
          "doctor"
        ]
      },
      "ok": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "status": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "inspected",
          "proposed",
          "saved",
          "rejected",
          "blocked",
          "failed"
        ]
      },
      "candidate_set": {
        "type": "object",
        "required": true,
        "nullable": true,
        "ref": "autopilot.roster_candidate_set.v1"
      },
      "receipt": {
        "type": "object",
        "required": true,
        "nullable": true,
        "ref": "autopilot.roster_setup_receipt.v1"
      },
      "diagnostics": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_diagnostic.v1"
        },
        "minItems": 0,
        "uniqueBy": "code",
        "orderedBy": "code"
      },
      "write_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "lock_count": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 0
      },
      "files_touched": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "result_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "result_sha256",
    "semantic_rules": [
      "zero-write actions have write_count=0 lock_count=0 files_touched=[]",
      "save failures before approval freshness acquire no lock",
      "save successes publish config last then read back"
    ]
  },
  "autopilot.roster_transition.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "transition_id",
      "from_roster",
      "to_roster",
      "reason",
      "requires_explicit_user_approval",
      "approved_at",
      "transition_sha256"
    ],
    "required": [
      "schema_version",
      "transition_id",
      "from_roster",
      "to_roster",
      "reason",
      "requires_explicit_user_approval",
      "approved_at",
      "transition_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.roster_transition.v1"
        ]
      },
      "transition_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "from_roster": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.saved_roster_ref.v1"
      },
      "to_roster": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.saved_roster_ref.v1"
      },
      "reason": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 1000
      },
      "requires_explicit_user_approval": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "approved_at": {
        "type": "string",
        "required": true,
        "nullable": false,
        "format": "utc-ms-z",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
      },
      "transition_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "transition_sha256",
    "semantic_rules": [
      "existing run with unavailable pinned roster requires explicit transition; no default drift or inferred replacement"
    ]
  },
  "autopilot.route_policy.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "route_policy_id",
      "revision",
      "provider_id",
      "allowed_auth_classes",
      "allowed_auth_sources",
      "billing_class",
      "billing_route_class",
      "allowed_apis",
      "allowed_service_tiers",
      "allowed_cache_policies",
      "allowed_system_prompt_profiles",
      "forbidden_gateways",
      "requires_live_billing_proof",
      "policy_state",
      "qualification_state",
      "non_certifying_seed",
      "route_policy_sha256"
    ],
    "required": [
      "schema_version",
      "route_policy_id",
      "revision",
      "provider_id",
      "allowed_auth_classes",
      "allowed_auth_sources",
      "billing_class",
      "billing_route_class",
      "allowed_apis",
      "allowed_service_tiers",
      "allowed_cache_policies",
      "allowed_system_prompt_profiles",
      "forbidden_gateways",
      "requires_live_billing_proof",
      "policy_state",
      "qualification_state",
      "non_certifying_seed",
      "route_policy_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.route_policy.v1"
        ]
      },
      "route_policy_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$"
      },
      "revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "provider_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "allowed_auth_classes": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "oauth",
            "api-key-plan-token",
            "api-key",
            "none",
            "unknown"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "allowed_auth_sources": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "stored",
            "runtime",
            "environment",
            "not-configured",
            "unknown"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "billing_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "plan-backed-subscription",
          "plan-token",
          "metered-third-party-blocked",
          "forbidden-metered-gateway",
          "unknown"
        ]
      },
      "billing_route_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "subscription-oauth",
          "plan-api-token",
          "third-party-metered-blocked",
          "gateway-forbidden"
        ]
      },
      "allowed_apis": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "openai-codex-responses",
            "anthropic-messages",
            "openai-completions"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "allowed_service_tiers": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": true,
          "values": [
            null,
            "priority"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic-null-first"
      },
      "allowed_cache_policies": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "provider-default",
            "none",
            "short",
            "long"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "allowed_system_prompt_profiles": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "pi-default.v1",
            "anthropic-autopilot-sanitized.v1"
          ]
        },
        "minItems": 1,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "forbidden_gateways": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "enum",
          "required": true,
          "nullable": false,
          "values": [
            "openrouter",
            "metered-frontier",
            "arbitrary-api-key"
          ]
        },
        "minItems": 3,
        "uniqueItems": true,
        "orderedBy": "lexicographic"
      },
      "requires_live_billing_proof": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "policy_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "unqualified-seed",
          "blocked-live-certification"
        ]
      },
      "qualification_state": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "unqualified-non-certifying-seed",
          "qualification-required",
          "synthetic-test-ready",
          "w4-certified-ready",
          "blocked-live-certification"
        ]
      },
      "non_certifying_seed": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "route_policy_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "route_policy_sha256",
    "semantic_rules": [
      "route_policy_sha256 omits only itself",
      "OpenRouter and arbitrary metered gateways are always forbidden",
      "credential shape is not billing authority",
      "policy_state unqualified-seed is not launch readiness"
    ]
  },
  "autopilot.route_resolution_request.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "provider_id",
      "api",
      "auth_class",
      "auth_source",
      "project_trusted"
    ],
    "required": [
      "schema_version",
      "provider_id",
      "api",
      "auth_class",
      "auth_source",
      "project_trusted"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.route_resolution_request.v1"
        ]
      },
      "provider_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,63}$",
        "minLength": 1,
        "maxLength": 64
      },
      "api": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "openai-codex-responses",
          "anthropic-messages",
          "openai-completions"
        ]
      },
      "auth_class": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "oauth",
          "api-key-plan-token",
          "api-key",
          "none",
          "unknown"
        ]
      },
      "auth_source": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "stored",
          "runtime",
          "environment",
          "not-configured",
          "unknown"
        ]
      },
      "project_trusted": {
        "type": "boolean",
        "required": true,
        "nullable": false
      }
    },
    "semantic_rules": [
      "route resolution takes explicit provider/api/auth facts; no recipe-name inference"
    ]
  },
  "autopilot.route_resolution_result.v1": {
    "closed": true,
    "field_order": [
      "schema_version",
      "matched",
      "route_policy_id",
      "route_policy_revision",
      "diagnostics",
      "result_sha256"
    ],
    "required": [
      "schema_version",
      "matched",
      "route_policy_id",
      "route_policy_revision",
      "diagnostics",
      "result_sha256"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.route_resolution_result.v1"
        ]
      },
      "matched": {
        "type": "boolean",
        "required": true,
        "nullable": false
      },
      "route_policy_id": {
        "type": "string",
        "required": true,
        "nullable": true,
        "minLength": 4,
        "maxLength": 80
      },
      "route_policy_revision": {
        "type": "integer",
        "required": true,
        "nullable": true,
        "minimum": 1
      },
      "diagnostics": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.roster_diagnostic.v1"
        },
        "minItems": 0,
        "uniqueBy": "code",
        "orderedBy": "code"
      },
      "result_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      }
    },
    "hash_field": "result_sha256",
    "semantic_rules": [
      "matched route must be direct route_policy_id/revision and conform to auth/billing/gateway rules"
    ]
  },
  "autopilot.saved_roster_ref.v1": {
    "closed": true,
    "field_order": [
      "roster_id",
      "roster_revision",
      "roster_sha256",
      "assignment_set_sha256",
      "path"
    ],
    "required": [
      "roster_id",
      "roster_revision",
      "roster_sha256",
      "assignment_set_sha256",
      "path"
    ],
    "optional": [],
    "fields": {
      "roster_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "assignment_set_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "path": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      }
    },
    "semantic_rules": [
      "path is create-only immutable revision path <scope-rosters>/<roster-id>/revision-<roster-revision>.json"
    ]
  },
  "autopilot.unit_spec.v2": {
    "closed": true,
    "field_order": [
      "schema_version",
      "workstream",
      "unit_id",
      "role",
      "template",
      "attempt",
      "objective",
      "cwd",
      "model",
      "thinking",
      "owned_paths",
      "read_only_paths",
      "untouchable_paths",
      "context_refs",
      "validation_commands",
      "status_output",
      "receipt_output",
      "evidence_dir",
      "stop_boundary",
      "quality_profile",
      "risk_level",
      "acceptance_criteria",
      "verification_plan",
      "closure_criteria",
      "upstream_refs",
      "timeout_seconds",
      "render_prompt_snapshot",
      "roster_id",
      "roster_revision",
      "roster_sha256",
      "assignment_sha256",
      "pre_run_selection_sha256",
      "request_profile"
    ],
    "required": [
      "schema_version",
      "workstream",
      "unit_id",
      "role",
      "template",
      "attempt",
      "objective",
      "cwd",
      "model",
      "thinking",
      "owned_paths",
      "read_only_paths",
      "untouchable_paths",
      "context_refs",
      "validation_commands",
      "status_output",
      "receipt_output",
      "evidence_dir",
      "stop_boundary",
      "quality_profile",
      "risk_level",
      "acceptance_criteria",
      "verification_plan",
      "closure_criteria",
      "upstream_refs",
      "timeout_seconds",
      "render_prompt_snapshot",
      "roster_id",
      "roster_revision",
      "roster_sha256",
      "assignment_sha256",
      "pre_run_selection_sha256",
      "request_profile"
    ],
    "optional": [],
    "fields": {
      "schema_version": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "autopilot.unit_spec.v2"
        ]
      },
      "workstream": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "unit_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,119}$",
        "minLength": 1,
        "maxLength": 120
      },
      "role": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "strategy",
          "implement",
          "validate",
          "fix",
          "adjudicate",
          "bughunt",
          "extract"
        ]
      },
      "template": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "strategy",
          "implement",
          "validate",
          "fix",
          "adjudicate",
          "bughunt",
          "extract"
        ]
      },
      "attempt": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "objective": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 20000
      },
      "cwd": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      },
      "model": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 200
      },
      "thinking": {
        "type": "enum",
        "required": true,
        "nullable": false,
        "values": [
          "high",
          "xhigh"
        ]
      },
      "owned_paths": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "uniqueItems": true
      },
      "read_only_paths": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "uniqueItems": true
      },
      "untouchable_paths": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "uniqueItems": true
      },
      "context_refs": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "ref": "autopilot.context_ref.v2"
        },
        "minItems": 0
      },
      "validation_commands": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0
      },
      "status_output": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      },
      "receipt_output": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      },
      "evidence_dir": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 4096
      },
      "stop_boundary": {
        "type": "string",
        "required": true,
        "nullable": false,
        "minLength": 1,
        "maxLength": 1000
      },
      "quality_profile": {
        "type": "string",
        "required": true,
        "nullable": true,
        "minLength": 1,
        "maxLength": 80
      },
      "risk_level": {
        "type": "enum",
        "required": true,
        "nullable": true,
        "values": [
          "low",
          "medium",
          "high",
          "critical",
          null
        ]
      },
      "acceptance_criteria": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 2000
        },
        "minItems": 0
      },
      "verification_plan": {
        "type": "object",
        "required": true,
        "nullable": true,
        "note": "closed v1 verification plan object preserved by source pin"
      },
      "closure_criteria": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "string",
          "required": true,
          "nullable": false,
          "minLength": 1,
          "maxLength": 2000
        },
        "minItems": 0
      },
      "upstream_refs": {
        "type": "array",
        "required": true,
        "nullable": false,
        "items": {
          "type": "object",
          "required": true,
          "nullable": false,
          "note": "closed v1 upstream ref object preserved by source pin"
        },
        "minItems": 0
      },
      "timeout_seconds": {
        "type": "integer",
        "required": true,
        "nullable": true,
        "minimum": 1
      },
      "render_prompt_snapshot": {
        "type": "boolean",
        "required": true,
        "nullable": true
      },
      "roster_id": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^[a-z][a-z0-9-]{0,95}$",
        "minLength": 1,
        "maxLength": 96
      },
      "roster_revision": {
        "type": "integer",
        "required": true,
        "nullable": false,
        "minimum": 1
      },
      "roster_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "assignment_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "pre_run_selection_sha256": {
        "type": "string",
        "required": true,
        "nullable": false,
        "pattern": "^sha256:[a-f0-9]{64}$",
        "minLength": 71,
        "maxLength": 71
      },
      "request_profile": {
        "type": "object",
        "required": true,
        "nullable": false,
        "ref": "autopilot.request_profile.v1"
      }
    },
    "semantic_rules": [
      "unit_spec.v2 is a closed explicit-null composition pinned to current v1 source hashes",
      "schema_version is not backward-compatible with v1; v1 bytes remain immutable historical evidence",
      "model/thinking must equal the assignment request profile; no fallback"
    ]
  }
} as const satisfies AutopilotRosterContractSchemaCatalog);

const AUTOPILOT_ROSTER_CONTRACT_SCHEMA_CATALOG: AutopilotRosterContractSchemaCatalog =
  AUTOPILOT_ROSTER_CONTRACT_SCHEMA_DEFINITIONS;

const ROSTER_SCHEMA_VERSION_SET: ReadonlySet<string> = new Set(AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES);
const UTC_MS_Z_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const V1_PROVIDER_IDENTITY_KEYS = new Set([
  'provider_id',
  'requested_model_id',
  'executed_model_id',
  'api',
  'thinking_level',
]);
const V1_WITNESS_KEYS = new Set([
  'id',
  'expected_signal',
  'required',
  'command',
  'inspection_target',
  'blocker_reason',
]);
const V1_VERIFICATION_PLAN_KEYS = new Set([
  'positive_witnesses',
  'negative_witnesses',
  'regression_witnesses',
  'real_boundary_witnesses',
  'blast_radius_checks',
  'docs_schema_prompt_checks',
  'dirty_tree_checks',
]);
const V1_UPSTREAM_REF_KEYS = new Set(['unit_id', 'purpose', 'status_ref', 'audit_ref']);
const ZERO_WRITE_RESULT_SCHEMAS: ReadonlySet<AutopilotRosterContractSchemaVersion> = new Set([
  'autopilot.existing_run_resolution_result.v1',
  'autopilot.historical_fixed_roster_adapter_result.v1',
  'autopilot.receipt_validation_result.v1',
]);

export const AUTOPILOT_ROSTER_CONTRACT_JSON_SCHEMAS = buildRosterJsonSchemas();

export function isAutopilotRosterContractSchemaVersion(
  value: string,
): value is AutopilotRosterContractSchemaVersion {
  return ROSTER_SCHEMA_VERSION_SET.has(value);
}

export function getAutopilotRosterContractSchemaDefinition(
  schemaVersion: AutopilotRosterContractSchemaVersion,
): AutopilotRosterContractSchemaDefinition {
  return AUTOPILOT_ROSTER_CONTRACT_SCHEMA_CATALOG[schemaVersion];
}

export function getAutopilotRosterJsonSchema(
  schemaVersion: AutopilotRosterContractSchemaVersion,
): AutopilotRosterJsonSchema {
  return AUTOPILOT_ROSTER_CONTRACT_JSON_SCHEMAS[schemaVersion];
}

export function autopilotRosterContractJsonSchemaSha256(
  schemaVersion: AutopilotRosterContractSchemaVersion,
): RosterSha256Digest {
  return rosterCanonicalSha256(AUTOPILOT_ROSTER_CONTRACT_JSON_SCHEMAS[schemaVersion]);
}

export function autopilotRosterContractCanonicalJson(value: unknown): string {
  return canonicalRosterJson(value);
}

export function autopilotRosterContractSha256(value: unknown): RosterSha256Digest {
  return rosterCanonicalSha256(value);
}

export function autopilotRosterContractSha256OmittingOwnField(
  value: unknown,
  omittedField: string,
): RosterSha256Digest {
  return rosterCanonicalSha256OmittingOwnField(value, omittedField);
}

export function autopilotRosterContractHashField(
  schemaVersion: AutopilotRosterContractSchemaVersion,
): string | null {
  return AUTOPILOT_ROSTER_CONTRACT_SCHEMA_CATALOG[schemaVersion].hash_field ?? null;
}

export function autopilotRosterContractIssues(
  schemaVersion: AutopilotRosterContractSchemaVersion,
  value: unknown,
): readonly string[] {
  const issues: string[] = [];
  validateSchemaValue(schemaVersion, value, schemaVersion, issues);
  if (issues.length === 0) issues.push(...semanticIssues(schemaVersion, requireRecord(value, schemaVersion, issues)));
  return Object.freeze(issues);
}

export function assertAutopilotRosterContract(
  schemaVersion: AutopilotRosterContractSchemaVersion,
  value: unknown,
): void {
  const issues = autopilotRosterContractIssues(schemaVersion, value);
  if (issues.length > 0) throw new AutopilotRosterContractValidationError(schemaVersion, issues);
}

export type AutopilotRosterContractForSchema<T extends AutopilotRosterContractSchemaVersion> =
  AutopilotRosterContractBySchemaVersion[T];

export function parseAutopilotRosterContract<const T extends AutopilotRosterContractSchemaVersion>(
  schemaVersion: T,
  value: unknown,
): AutopilotRosterContractForSchema<T> {
  assertAutopilotRosterContract(schemaVersion, value);
  return value as AutopilotRosterContractForSchema<T>;
}

export function parseAutopilotRosterContractJson<const T extends AutopilotRosterContractSchemaVersion>(
  schemaVersion: T,
  text: string,
): AutopilotRosterContractForSchema<T> {
  return parseAutopilotRosterContract(schemaVersion, parseRosterJsonWithDuplicateKeyRejection(text));
}

export function parseAutopilotRoster(value: unknown): AutopilotRosterContractBySchemaVersion['autopilot.roster.v1'] {
  return parseAutopilotRosterContract('autopilot.roster.v1', value);
}

export function parseAutopilotRosterCandidateSet(
  value: unknown,
): AutopilotRosterContractBySchemaVersion['autopilot.roster_candidate_set.v1'] {
  return parseAutopilotRosterContract('autopilot.roster_candidate_set.v1', value);
}

export function parseAutopilotRosterConfig(
  value: unknown,
): AutopilotRosterContractBySchemaVersion['autopilot.roster_config.v1'] {
  return parseAutopilotRosterContract('autopilot.roster_config.v1', value);
}

export function parseAutopilotPreRunSelection(
  value: unknown,
): AutopilotRosterContractBySchemaVersion['autopilot.pre_run_selection.v1'] {
  return parseAutopilotRosterContract('autopilot.pre_run_selection.v1', value);
}

export function parseAutopilotUnitSpecV2(
  value: unknown,
): AutopilotRosterContractBySchemaVersion['autopilot.unit_spec.v2'] {
  return parseAutopilotRosterContract('autopilot.unit_spec.v2', value);
}

export function parseAutopilotReceiptV2(
  value: unknown,
): AutopilotRosterContractBySchemaVersion['autopilot.receipt.v2'] {
  return parseAutopilotRosterContract('autopilot.receipt.v2', value);
}

export function parseAutopilotHistoricalFixedRosterAdapterRequest(
  value: unknown,
): AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_adapter_request.v1'] {
  return parseAutopilotRosterContract('autopilot.historical_fixed_roster_adapter_request.v1', value);
}

export function parseAutopilotHistoricalFixedRosterAdapterAdmission(
  value: unknown,
): AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_adapter_admission.v1'] {
  return parseAutopilotRosterContract('autopilot.historical_fixed_roster_adapter_admission.v1', value);
}

export function parseAutopilotHistoricalFixedRosterAdapterResult(
  value: unknown,
): AutopilotRosterContractBySchemaVersion['autopilot.historical_fixed_roster_adapter_result.v1'] {
  return parseAutopilotRosterContract('autopilot.historical_fixed_roster_adapter_result.v1', value);
}

export function computeAutopilotRosterCandidateSetId(
  candidateSet: AutopilotRosterContractBySchemaVersion['autopilot.roster_candidate_set.v1'],
): string {
  const hex = rosterCanonicalSha256Hex(omitCandidateSetIdentity(candidateSet));
  return `candidate-set-${hex.slice(0, 16)}`;
}

export function computeAutopilotAssignmentSetSha256(
  assignments: readonly AutopilotRosterContractBySchemaVersion['autopilot.assignment.v1'][],
): RosterSha256Digest {
  const assignmentSha256s = assignments.map((assignment) => assignment.assignment_sha256);
  return rosterCanonicalSha256({
    schema_version: 'autopilot.assignment_set.v1',
    role_order: AUTOPILOT_ROSTER_ROLE_ORDER,
    assignment_sha256s: assignmentSha256s,
  });
}

export function computeAutopilotRosterContractObjectHash(
  schemaVersion: AutopilotRosterContractSchemaVersion,
  value: unknown,
): RosterSha256Digest | null {
  const hashField = AUTOPILOT_ROSTER_CONTRACT_SCHEMA_CATALOG[schemaVersion].hash_field;
  return hashField === undefined ? null : rosterCanonicalSha256OmittingOwnField(value, hashField);
}

function buildRosterJsonSchemas(): Readonly<Record<AutopilotRosterContractSchemaVersion, AutopilotRosterJsonSchema>> {
  const output: Partial<Record<AutopilotRosterContractSchemaVersion, AutopilotRosterJsonSchema>> = {};
  for (const schemaVersion of AUTOPILOT_ROSTER_SCHEMA_VERSION_VALUES) {
    const definition = AUTOPILOT_ROSTER_CONTRACT_SCHEMA_CATALOG[schemaVersion];
    const properties: Record<string, unknown> = {};
    for (const fieldName of definition.field_order) {
      const field = definition.fields[fieldName];
      if (field !== undefined) properties[fieldName] = fieldToJsonSchema(field);
    }
    output[schemaVersion] = deepFreezeRosterAuthority({
      $id: `${AUTOPILOT_ROSTER_SCHEMA_ID_BASE}/${schemaVersion}.json`,
      type: 'object',
      additionalProperties: false,
      properties,
      required: [...definition.required],
    });
  }
  return deepFreezeRosterAuthority(output as Readonly<Record<AutopilotRosterContractSchemaVersion, AutopilotRosterJsonSchema>>);
}

function fieldToJsonSchema(field: AutopilotRosterContractFieldDefinition): AutopilotRosterJsonSchema {
  const schema = fieldToNonNullJsonSchema(field);
  if (!field.nullable || (field.type === 'enum' && field.values?.includes(null) === true)) return schema;
  return Object.freeze({ anyOf: [schema, { type: 'null' }] });
}

function fieldToNonNullJsonSchema(field: AutopilotRosterContractFieldDefinition): AutopilotRosterJsonSchema {
  if (field.type === 'enum') return Object.freeze({ enum: [...(field.values ?? [])] });
  if (field.type === 'string') {
    const schema: Record<string, unknown> = { type: 'string' };
    if (field.minLength !== undefined) schema['minLength'] = field.minLength;
    if (field.maxLength !== undefined) schema['maxLength'] = field.maxLength;
    if (field.pattern !== undefined) schema['pattern'] = field.pattern;
    if (field.format !== undefined) schema['format'] = field.format;
    return Object.freeze(schema);
  }
  if (field.type === 'integer') {
    const schema: Record<string, unknown> = { type: 'integer' };
    if (field.minimum !== undefined) schema['minimum'] = field.minimum;
    if (field.maximum !== undefined) schema['maximum'] = field.maximum;
    return Object.freeze(schema);
  }
  if (field.type === 'boolean') return Object.freeze({ type: 'boolean' });
  if (field.type === 'array') {
    const schema: Record<string, unknown> = { type: 'array' };
    if (field.items !== undefined) schema['items'] = fieldToJsonSchema(field.items);
    if (field.minItems !== undefined) schema['minItems'] = field.minItems;
    if (field.maxItems !== undefined) schema['maxItems'] = field.maxItems;
    if (field.uniqueItems !== undefined) schema['uniqueItems'] = field.uniqueItems;
    return Object.freeze(schema);
  }
  if (field.ref !== undefined) {
    return Object.freeze({ $ref: `${AUTOPILOT_ROSTER_SCHEMA_ID_BASE}/${field.ref}.json` });
  }
  return Object.freeze({ type: 'object' });
}

function validateSchemaValue(
  schemaVersion: AutopilotRosterContractSchemaVersion,
  value: unknown,
  label: string,
  issues: string[],
): void {
  const definition = AUTOPILOT_ROSTER_CONTRACT_SCHEMA_CATALOG[schemaVersion];
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, new Set(definition.field_order), label, issues);
  for (const key of definition.required) {
    if (!hasOwn(record, key)) issues.push(`${label} missing required property ${JSON.stringify(key)}`);
  }
  for (const fieldName of definition.field_order) {
    if (!hasOwn(record, fieldName)) continue;
    const field = definition.fields[fieldName];
    if (field !== undefined) validateField(field, record[fieldName], `${label}/${fieldName}`, issues);
  }
}

function validateField(
  field: AutopilotRosterContractFieldDefinition,
  value: unknown,
  label: string,
  issues: string[],
): void {
  if (value === null) {
    if (!field.nullable) issues.push(`${label} must not be null`);
    return;
  }
  if (field.type === 'enum') {
    if (!enumContains(field.values ?? [], value)) {
      issues.push(`${label} must be one of ${(field.values ?? []).map((entry) => JSON.stringify(entry)).join(', ')}`);
    }
    return;
  }
  if (field.type === 'string') {
    expectString(value, label, issues, field);
    return;
  }
  if (field.type === 'integer') {
    expectInteger(value, label, issues, field.minimum, field.maximum);
    return;
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') issues.push(`${label} must be boolean`);
    return;
  }
  if (field.type === 'object') {
    if (field.ref !== undefined) {
      validateSchemaValue(field.ref, value, label, issues);
      return;
    }
    requireRecord(value, label, issues);
    return;
  }
  validateArray(field, value, label, issues);
}

function validateArray(
  field: AutopilotRosterContractFieldDefinition,
  value: unknown,
  label: string,
  issues: string[],
): void {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be array`);
    return;
  }
  if (field.minItems !== undefined && value.length < field.minItems) {
    issues.push(`${label} must contain at least ${String(field.minItems)} item(s)`);
  }
  if (field.maxItems !== undefined && value.length > field.maxItems) {
    issues.push(`${label} must contain at most ${String(field.maxItems)} item(s)`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, String(index))) issues.push(`${label}/${String(index)} is a sparse array hole`);
    if (field.items !== undefined) validateField(field.items, value[index], `${label}/${String(index)}`, issues);
  }
  if (field.uniqueItems === true) pushUniqueItemIssues(value, label, issues);
  if (field.uniqueBy !== undefined) pushUniqueByIssues(value, field.uniqueBy, label, issues);
  if (field.orderedBy !== undefined) pushOrderIssues(value, field.orderedBy, label, issues);
}

function semanticIssues(
  schemaVersion: AutopilotRosterContractSchemaVersion,
  record: Readonly<Record<string, unknown>> | undefined,
): string[] {
  if (record === undefined) return [];
  const issues: string[] = [];
  const hashField = AUTOPILOT_ROSTER_CONTRACT_SCHEMA_CATALOG[schemaVersion].hash_field;
  if (hashField !== undefined) pushHashFieldIssues(schemaVersion, record, hashField, issues);
  if (schemaVersion === 'autopilot.assignment.v1' || schemaVersion === 'autopilot.request_profile.v1' || schemaVersion === 'autopilot.historical_fixed_roster_role.v1') {
    pushModelRelationIssues(record, schemaVersion, issues);
  }
  if (schemaVersion === 'autopilot.roster.v1') pushRosterIssues(record, issues);
  if (schemaVersion === 'autopilot.roster_candidate_set.v1') pushCandidateSetIssues(record, issues);
  if (schemaVersion === 'autopilot.roster_config.v1') pushRosterConfigIssues(record, issues);
  if (schemaVersion === 'autopilot.roster_setup_receipt.v1') pushRosterSetupReceiptIssues(record, issues);
  if (schemaVersion === 'autopilot.unit_spec.v2') pushUnitSpecV2Issues(record, issues);
  if (schemaVersion === 'autopilot.receipt.v2') pushReceiptV2Issues(record, issues);
  if (schemaVersion === 'autopilot.auth_summary.v1' && record['secret_fields_present'] !== false) {
    issues.push('auth_summary secret_fields_present must be false');
  }
  if (schemaVersion === 'autopilot.roster_diagnostic.v1' && record['secret_free'] !== true) {
    issues.push('roster_diagnostic secret_free must be true');
  }
  if (schemaVersion === 'autopilot.evidence_ref.v1' && record['secret_free'] !== true) {
    issues.push('evidence_ref secret_free must be true');
  }
  if (schemaVersion === 'autopilot.historical_fixed_roster_adapter_admission.v1') pushHistoricalAdmissionIssues(record, issues);
  if (schemaVersion === 'autopilot.historical_fixed_roster_adapter_result.v1') pushHistoricalResultIssues(record, issues);
  if (ZERO_WRITE_RESULT_SCHEMAS.has(schemaVersion)) pushZeroWriteResultIssues(record, schemaVersion, issues);
  if (schemaVersion === 'autopilot.roster_tool_result.v1') pushRosterToolResultIssues(record, issues);
  if (schemaVersion === 'autopilot.receipt_validation_result.v1') pushReceiptValidationResultIssues(record, issues);
  return issues;
}

function pushHashFieldIssues(
  schemaVersion: AutopilotRosterContractSchemaVersion,
  record: Readonly<Record<string, unknown>>,
  hashField: string,
  issues: string[],
): void {
  const actual = stringField(record, hashField);
  if (actual === undefined) return;
  const expected = rosterCanonicalSha256OmittingOwnField(record, hashField);
  if (actual !== expected) issues.push(`${schemaVersion}/${hashField} hash mismatch: expected ${expected}, got ${actual}`);
}

function pushModelRelationIssues(record: Readonly<Record<string, unknown>>, label: string, issues: string[]): void {
  const providerId = stringField(record, 'provider_id');
  const modelId = stringField(record, 'model_id');
  const model = stringField(record, 'model');
  if (providerId !== undefined && modelId !== undefined && model !== undefined && model !== `${providerId}/${modelId}`) {
    issues.push(`${label} model must equal provider_id/model_id`);
  }
}

function pushRosterIssues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  const assignments = recordArray(record, 'assignments');
  const assignmentSet = stringField(record, 'assignment_set_sha256');
  if (assignments !== undefined && assignmentSet !== undefined) {
    const assignmentHashes: string[] = [];
    for (const assignment of assignments) {
      const assignmentRecord = recordValue(assignment);
      const assignmentHash = assignmentRecord === undefined ? undefined : stringField(assignmentRecord, 'assignment_sha256');
      if (assignmentHash !== undefined) assignmentHashes.push(assignmentHash);
    }
    if (assignmentHashes.length === assignments.length) {
      const expected = rosterCanonicalSha256({
        schema_version: 'autopilot.assignment_set.v1',
        role_order: AUTOPILOT_ROSTER_ROLE_ORDER,
        assignment_sha256s: assignmentHashes,
      });
      if (assignmentSet !== expected) issues.push(`roster assignment_set_sha256 mismatch: expected ${expected}, got ${assignmentSet}`);
    }
  }
  if (record['scope'] !== record['selected_scope']) issues.push('roster scope and selected_scope must match');
  if (record['generation_source'] === 'w0-non-certifying-seed') {
    if (record['certification_manifest_id'] !== null) issues.push('W0 seed roster certification_manifest_id must be null');
    if (record['certification_manifest_sha256'] !== null) issues.push('W0 seed roster certification_manifest_sha256 must be null');
  }
}

function pushCandidateSetIssues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  const candidateSetId = stringField(record, 'candidate_set_id');
  if (candidateSetId !== undefined) {
    const expected = `candidate-set-${rosterCanonicalSha256Hex(omitCandidateSetIdentity(record)).slice(0, 16)}`;
    if (candidateSetId !== expected) issues.push(`candidate_set_id mismatch: expected ${expected}, got ${candidateSetId}`);
  }
  const candidates = recordArray(record, 'candidates');
  if (candidates !== undefined) {
    const sortKeys = new Set<string>();
    for (const candidate of candidates) {
      const candidateRecord = recordValue(candidate);
      const sortKey = candidateRecord === undefined ? undefined : stringField(candidateRecord, 'candidate_sort_key');
      if (sortKey !== undefined) {
        if (sortKeys.has(sortKey)) issues.push(`candidates duplicate candidate_sort_key ${JSON.stringify(sortKey)}`);
        sortKeys.add(sortKey);
      }
    }
  }
}

function pushRosterConfigIssues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  const defaultId = stringField(record, 'default_roster_id');
  const defaultRevision = numberField(record, 'default_roster_revision');
  const defaultHash = stringField(record, 'default_roster_sha256');
  const rosters = recordArray(record, 'rosters');
  if (defaultId === undefined || defaultRevision === undefined || defaultHash === undefined || rosters === undefined) return;
  let matches = 0;
  for (const roster of rosters) {
    const rosterRecord = recordValue(roster);
    if (rosterRecord === undefined) continue;
    if (
      stringField(rosterRecord, 'roster_id') === defaultId &&
      numberField(rosterRecord, 'roster_revision') === defaultRevision &&
      stringField(rosterRecord, 'roster_sha256') === defaultHash
    ) {
      matches += 1;
    }
  }
  if (matches !== 1) issues.push('roster_config default roster tuple must match exactly one saved roster ref');
}

function pushRosterSetupReceiptIssues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  if (record['fresh_session_required'] !== true) issues.push('roster_setup_receipt fresh_session_required must be true');
  if (record['zero_secrets'] !== true) issues.push('roster_setup_receipt zero_secrets must be true');
  const savedRosters = recordArray(record, 'saved_rosters');
  const approved = recordArray(record, 'approved_roster_sha256s');
  if (savedRosters !== undefined && approved !== undefined) {
    const savedHashes = savedRosters.map((entry) => {
      const entryRecord = recordValue(entry);
      return entryRecord === undefined ? undefined : stringField(entryRecord, 'roster_sha256');
    });
    if (savedHashes.every((entry): entry is string => entry !== undefined)) {
      if (savedHashes.length !== approved.length || savedHashes.some((entry, index) => approved[index] !== entry)) {
        issues.push('approved_roster_sha256s must equal saved_rosters roster_sha256s in order');
      }
    }
  }
}

function pushUnitSpecV2Issues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  if (record['template'] !== record['role']) issues.push('unit_spec.v2 template must equal role');
  const requestProfile = recordValue(record['request_profile']);
  if (requestProfile !== undefined) {
    const model = stringField(record, 'model');
    const thinking = stringField(record, 'thinking');
    const requestedModel = stringField(requestProfile, 'model');
    const requestedThinking = stringField(requestProfile, 'thinking');
    if (model !== undefined && requestedModel !== undefined && model !== requestedModel) {
      issues.push('unit_spec.v2 model must equal request_profile.model');
    }
    if (thinking !== undefined && requestedThinking !== undefined && thinking !== requestedThinking) {
      issues.push('unit_spec.v2 thinking must equal request_profile.thinking');
    }
  }
  const verificationPlan = record['verification_plan'];
  if (verificationPlan !== null) pushVerificationPlanV1Issues(verificationPlan, 'unit_spec.v2/verification_plan', issues);
  const upstreamRefs = recordArray(record, 'upstream_refs');
  if (upstreamRefs !== undefined) {
    for (const [index, ref] of upstreamRefs.entries()) pushUpstreamRefV1Issues(ref, `unit_spec.v2/upstream_refs/${String(index)}`, issues);
  }
}

function pushReceiptV2Issues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  pushProviderIdentityV1Issues(record['provider_identity'], 'receipt.v2/provider_identity', issues);
  const requestProfile = recordValue(record['request_profile']);
  const observedProfile = recordValue(record['observed_profile']);
  const providerIdentity = recordValue(record['provider_identity']);
  if (requestProfile === undefined || observedProfile === undefined) return;
  compareRecordFields(requestProfile, observedProfile, ['provider_id', 'api', 'thinking', 'service_tier', 'cache_policy', 'system_prompt_profile', 'route_policy_id', 'route_policy_revision', 'request_profile_sha256'], 'receipt.v2 request_profile/observed_profile', issues);
  const requestModelId = stringField(requestProfile, 'model_id');
  if (requestModelId !== undefined) {
    if (stringField(observedProfile, 'requested_model_id') !== requestModelId) issues.push('receipt.v2 observed requested_model_id must equal request_profile.model_id');
    if (stringField(observedProfile, 'executed_model_id') !== requestModelId) issues.push('receipt.v2 observed executed_model_id must equal request_profile.model_id');
  }
  if (providerIdentity !== undefined) {
    if (stringField(providerIdentity, 'provider_id') !== stringField(requestProfile, 'provider_id')) issues.push('receipt.v2 provider_identity provider_id must equal request_profile.provider_id');
    if (stringField(providerIdentity, 'requested_model_id') !== requestModelId) issues.push('receipt.v2 provider_identity requested_model_id must equal request_profile.model_id');
    if (stringField(providerIdentity, 'executed_model_id') !== requestModelId) issues.push('receipt.v2 provider_identity executed_model_id must equal request_profile.model_id');
    if (stringField(providerIdentity, 'api') !== stringField(requestProfile, 'api')) issues.push('receipt.v2 provider_identity api must equal request_profile.api');
    if (stringField(providerIdentity, 'thinking_level') !== stringField(requestProfile, 'thinking')) issues.push('receipt.v2 provider_identity thinking_level must equal request_profile.thinking');
  }
}

function pushHistoricalAdmissionIssues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  const admitted = record['admitted'];
  const reason = record['reason'];
  if (admitted === true && reason !== 'admitted') issues.push('historical admission admitted=true requires reason admitted');
  if (admitted === false && reason === 'admitted') issues.push('historical admission admitted=false requires a fail-closed reason');
  if (record['historical_bytes_mutated'] !== false) issues.push('historical admission must preserve historical bytes');
  if (admitted === true) {
    if (record['pre_run_selection_absent'] !== true) issues.push('historical admission requires absent pre-run selection');
    if (record['no_conflicting_evidence'] !== true) issues.push('historical admission requires no conflicting evidence');
  }
}

function pushHistoricalResultIssues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  if (record['historical_bytes_mutated'] !== false) issues.push('historical adapter result must preserve historical bytes');
  const ok = record['ok'];
  const selectedFields = [
    'selected_scope',
    'selected_roster_id',
    'selected_roster_revision',
    'selected_roster_sha256',
    'assignment_set_sha256',
    'selection_identity_sha256',
  ] as const;
  if (ok === true) {
    for (const field of selectedFields) if (record[field] === null) issues.push(`historical adapter ok result requires ${field}`);
  }
  if (ok === false) {
    for (const field of selectedFields) if (record[field] !== null) issues.push(`historical adapter blocked result requires null ${field}`);
  }
}

function pushZeroWriteResultIssues(
  record: Readonly<Record<string, unknown>>,
  schemaVersion: AutopilotRosterContractSchemaVersion,
  issues: string[],
): void {
  if (record['write_count'] !== 0) issues.push(`${schemaVersion} must be zero-write`);
  if (record['lock_count'] !== 0) issues.push(`${schemaVersion} must be zero-lock`);
  const filesTouched = recordArray(record, 'files_touched');
  if (filesTouched !== undefined && filesTouched.length !== 0) issues.push(`${schemaVersion} must not touch files`);
}

function pushRosterToolResultIssues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  const action = record['action'];
  if (action === 'inspect' || action === 'propose' || action === 'reject' || action === 'doctor') {
    pushZeroWriteResultIssues(record, 'autopilot.roster_tool_result.v1', issues);
  }
}

function pushReceiptValidationResultIssues(record: Readonly<Record<string, unknown>>, issues: string[]): void {
  if (record['action'] !== 'validate-receipt') issues.push('receipt_validation_result action must be validate-receipt');
}

function pushProviderIdentityV1Issues(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, V1_PROVIDER_IDENTITY_KEYS, label, issues);
  for (const key of V1_PROVIDER_IDENTITY_KEYS) {
    if (!hasOwn(record, key)) issues.push(`${label} missing required property ${JSON.stringify(key)}`);
    else expectString(record[key], `${label}/${key}`, issues, { type: 'string', required: true, nullable: false, minLength: 1, maxLength: 200 });
  }
}

function pushVerificationPlanV1Issues(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, V1_VERIFICATION_PLAN_KEYS, label, issues);
  for (const key of V1_VERIFICATION_PLAN_KEYS) {
    if (!hasOwn(record, key)) issues.push(`${label} missing required property ${JSON.stringify(key)}`);
    const entries = recordArray(record, key);
    if (entries === undefined) continue;
    for (const [index, witness] of entries.entries()) pushWitnessV1Issues(witness, `${label}/${key}/${String(index)}`, issues);
  }
}

function pushWitnessV1Issues(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, V1_WITNESS_KEYS, label, issues);
  for (const key of ['id', 'expected_signal'] as const) {
    if (!hasOwn(record, key)) issues.push(`${label} missing required property ${JSON.stringify(key)}`);
    else expectString(record[key], `${label}/${key}`, issues, { type: 'string', required: true, nullable: false, minLength: 1, maxLength: 1000 });
  }
  if (!hasOwn(record, 'required')) issues.push(`${label} missing required property "required"`);
  else if (typeof record['required'] !== 'boolean') issues.push(`${label}/required must be boolean`);
  for (const key of ['command', 'inspection_target', 'blocker_reason'] as const) {
    if (hasOwn(record, key)) expectString(record[key], `${label}/${key}`, issues, { type: 'string', required: true, nullable: false, minLength: 1, maxLength: 1000 });
  }
}

function pushUpstreamRefV1Issues(value: unknown, label: string, issues: string[]): void {
  const record = requireRecord(value, label, issues);
  if (record === undefined) return;
  checkKnownKeys(record, V1_UPSTREAM_REF_KEYS, label, issues);
  for (const key of ['unit_id', 'purpose'] as const) {
    if (!hasOwn(record, key)) issues.push(`${label} missing required property ${JSON.stringify(key)}`);
    else expectString(record[key], `${label}/${key}`, issues, { type: 'string', required: true, nullable: false, minLength: 1, maxLength: 1000 });
  }
  for (const key of ['status_ref', 'audit_ref'] as const) {
    if (hasOwn(record, key)) expectString(record[key], `${label}/${key}`, issues, { type: 'string', required: true, nullable: false, minLength: 1, maxLength: 4096 });
  }
}

function compareRecordFields(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string,
  issues: string[],
): void {
  for (const field of fields) {
    if (left[field] !== right[field]) issues.push(`${label} ${field} mismatch`);
  }
}

function omitCandidateSetIdentity(value: unknown): Readonly<Record<string, unknown>> {
  const record = requireRecord(value, 'candidate_set_id preimage', []);
  if (record === undefined) return {};
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== 'candidate_set_id' && key !== 'candidate_set_sha256') output[key] = record[key];
  }
  return output;
}

function requireRecord(
  value: unknown,
  label: string,
  issues: string[],
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return value as Readonly<Record<string, unknown>>;
  }
  issues.push(`${label} must be an object`);
  return undefined;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function recordArray(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function checkKnownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`${label} has unexpected property ${JSON.stringify(key)}`);
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function enumContains(values: readonly AutopilotRosterContractEnumValue[], value: unknown): boolean {
  return values.some((entry) => entry === value);
}

function expectString(
  value: unknown,
  label: string,
  issues: string[],
  field: AutopilotRosterContractFieldDefinition,
): void {
  if (typeof value !== 'string') {
    issues.push(`${label} must be string`);
    return;
  }
  if (field.minLength !== undefined && value.length < field.minLength) {
    issues.push(`${label} must contain at least ${String(field.minLength)} character(s)`);
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    issues.push(`${label} must contain at most ${String(field.maxLength)} character(s)`);
  }
  if (field.pattern !== undefined && !new RegExp(field.pattern, 'u').test(value)) issues.push(`${label} has invalid format`);
  if (field.format === 'utc-ms-z' && !UTC_MS_Z_PATTERN.test(value)) issues.push(`${label} must be UTC millisecond timestamp ending in Z`);
}

function expectInteger(
  value: unknown,
  label: string,
  issues: string[],
  minimum: number | undefined,
  maximum: number | undefined,
): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.push(`${label} must be integer`);
    return;
  }
  if (minimum !== undefined && value < minimum) issues.push(`${label} must be >= ${String(minimum)}`);
  if (maximum !== undefined && value > maximum) issues.push(`${label} must be <= ${String(maximum)}`);
}

function pushUniqueItemIssues(values: readonly unknown[], label: string, issues: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = canonicalRosterJson(value);
    if (seen.has(key)) issues.push(`${label} contains duplicate item`);
    seen.add(key);
  }
}

function pushUniqueByIssues(values: readonly unknown[], uniqueBy: string, label: string, issues: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    const record = recordValue(value);
    const key = record === undefined ? undefined : uniqueByKey(record, uniqueBy);
    if (key === undefined) {
      issues.push(`${label} uniqueBy ${uniqueBy} must resolve to string or number`);
      continue;
    }
    if (seen.has(key)) issues.push(`${label} duplicates ${uniqueBy} ${JSON.stringify(key)}`);
    seen.add(key);
  }
}

function uniqueByKey(record: Readonly<Record<string, unknown>>, uniqueBy: string): string | undefined {
  if (uniqueBy === 'model_id+api') return stringTupleKey(record, 'model_id', 'api');
  if (uniqueBy === 'roster_id+revision') return tupleKey(record, 'roster_id', 'roster_revision');
  const uniqueValue = record[uniqueBy];
  return typeof uniqueValue === 'string' || typeof uniqueValue === 'number' ? String(uniqueValue) : undefined;
}

function pushOrderIssues(values: readonly unknown[], orderedBy: string, label: string, issues: string[]): void {
  const keys = values.map((value) => orderKey(value, orderedBy));
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1];
    const current = keys[index];
    if (previous === undefined || current === undefined) continue;
    if (previous > current) issues.push(`${label} must be ordered by ${orderedBy}`);
    if ((orderedBy === 'candidate_sort_key' || orderedBy === 'roster_id_then_revision' || orderedBy === 'route_policy_id_then_revision' || orderedBy === 'recipe_id_then_recipe_revision') && previous === current) {
      issues.push(`${label} contains tied ${orderedBy} sort key ${previous}`);
    }
  }
}

function orderKey(value: unknown, orderedBy: string): string | undefined {
  if (orderedBy === 'lexicographic') return typeof value === 'string' ? value : JSON.stringify(value);
  if (orderedBy === 'lexicographic-null-first') return value === null ? '\u0000' : typeof value === 'string' ? `\u0001${value}` : `\u0001${JSON.stringify(value)}`;
  const record = recordValue(value);
  if (record === undefined) return undefined;
  if (orderedBy === 'role_order') {
    const role = stringField(record, 'role');
    const index = AUTOPILOT_ROSTER_ROLE_ORDER.findIndex((entry) => entry === role);
    return index < 0 ? undefined : String(index).padStart(2, '0');
  }
  if (orderedBy === 'roster_id_then_revision' || orderedBy === 'roster_id,roster_revision') return tupleKey(record, 'roster_id', 'roster_revision');
  if (orderedBy === 'route_policy_id_then_revision') return tupleKey(record, 'route_policy_id', 'revision');
  if (orderedBy === 'recipe_id_then_recipe_revision') return tupleKey(record, 'recipe_id', 'recipe_revision');
  if (orderedBy === 'model_id,api') return stringTupleKey(record, 'model_id', 'api');
  if (orderedBy === 'roster_id,roster_revision presentation order') return undefined;
  const fieldValue = record[orderedBy];
  return typeof fieldValue === 'string' || typeof fieldValue === 'number' ? String(fieldValue) : undefined;
}

function tupleKey(record: Readonly<Record<string, unknown>>, leftKey: string, rightKey: string): string | undefined {
  const left = record[leftKey];
  const right = record[rightKey];
  if (typeof left !== 'string' || typeof right !== 'number') return undefined;
  return `${left}\u0000${String(right).padStart(12, '0')}`;
}

function stringTupleKey(record: Readonly<Record<string, unknown>>, leftKey: string, rightKey: string): string | undefined {
  const left = record[leftKey];
  const right = record[rightKey];
  if (typeof left !== 'string' || typeof right !== 'string') return undefined;
  return `${left}\u0000${right}`;
}

export function makeAutopilotRosterDiagnostic(
  code: string,
  severity: 'info' | 'warning' | 'error' | 'fatal',
): AutopilotRosterContractBySchemaVersion['autopilot.roster_diagnostic.v1'] {
  return parseAutopilotRosterContract('autopilot.roster_diagnostic.v1', {
    code,
    severity,
    message: `${code} fixture diagnostic`,
    remediation: 'Follow the Phase 37 W0 roster contract freeze.',
    secret_free: true,
  });
}
