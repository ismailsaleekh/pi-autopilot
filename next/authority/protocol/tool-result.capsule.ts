import { diagnosticSchema } from "./identifiers.js";
import {
  defineCapsule,
  jsonValue,
  literal,
  object,
  union,
} from "./schema.js";
import type {
  Infer,
  JsonValue,
  Schema,
  SchemaCapsule,
} from "./schema.js";

export function toolResultSchemaFor<const ValueSchema extends Schema>(valueSchema: ValueSchema) {
  return union([
    object({
      kind: literal("ok"),
      value: valueSchema,
    }),
    object({
      diagnostic: diagnosticSchema,
      kind: literal("retry"),
    }),
  ]);
}

const toolResultTemplateSchema = toolResultSchemaFor(jsonValue());
type ToolResultTemplate = Infer<typeof toolResultTemplateSchema>;

type BindToolResult<Template, Value> = Template extends { readonly kind: "ok" }
  ? { readonly [Field in keyof Template]: Field extends "value" ? Value : Template[Field] }
  : Template;

export type ToolResult<Value> = BindToolResult<ToolResultTemplate, Value>;

export function makeToolResultCapsule<
  const Name extends string,
  const ValueSchema extends Schema,
>(
  name: Name,
  valueSchema: ValueSchema,
): SchemaCapsule<Name, ToolResult<Infer<ValueSchema>>>;
export function makeToolResultCapsule(name: string, valueSchema: Schema) {
  return defineCapsule(name, toolResultSchemaFor(valueSchema));
}

export const toolResultCapsule = makeToolResultCapsule("ToolResult", jsonValue());

export const toolResultExhaustive = Object.freeze({
  ok: true,
  retry: true,
}) satisfies Readonly<Record<ToolResult<JsonValue>["kind"], true>>;
