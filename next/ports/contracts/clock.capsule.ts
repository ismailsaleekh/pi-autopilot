import {
  actionIdSchema,
  digestSchema,
  kindIdSchema,
  runIdSchema,
} from "../../authority/protocol/identifiers.js";
import {
  defineCapsule,
  literal,
  natural,
  object,
  union,
} from "../../authority/protocol/schema.js";
import type { Infer } from "../../authority/protocol/schema.js";
import { toolResultSchemaFor } from "../../authority/protocol/tool-result.capsule.js";
import { defineIntentCapsule } from "./intent-capsule.js";

export const observeClockSchema = object({
  actionId: actionIdSchema,
  inputs: object({
    clockId: kindIdSchema,
  }),
  kind: literal("observe-clock"),
  preconditions: object({
    notBeforeTick: natural(),
  }),
  runId: runIdSchema,
});

export const clockIntentSchema = union([
  observeClockSchema,
]);

const clockResultSchema = object({
  clockId: kindIdSchema,
  sourceDigest: digestSchema,
  tick: natural(),
});

export const clockObservedSchema = object({
  actionId: actionIdSchema,
  kind: literal("clock-observed"),
  result: toolResultSchemaFor(clockResultSchema),
  runId: runIdSchema,
});

export const clockObservationSchema = union([
  clockObservedSchema,
]);

export type ObserveClock = Infer<typeof observeClockSchema>;
export type ClockIntent = Infer<typeof clockIntentSchema>;
export type ClockObserved = Infer<typeof clockObservedSchema>;
export type ClockObservation = Infer<typeof clockObservationSchema>;

export const clockIntentCapsule = defineIntentCapsule("ClockIntent", "clock", clockIntentSchema);
export const clockObservationCapsule = defineCapsule("ClockObservation", clockObservationSchema);

export const clockIntentExhaustive = Object.freeze({
  "observe-clock": true,
}) satisfies Readonly<Record<ClockIntent["kind"], true>>;

export const clockObservationExhaustive = Object.freeze({
  "clock-observed": true,
}) satisfies Readonly<Record<ClockObservation["kind"], true>>;
