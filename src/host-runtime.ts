type HostError = new (message: string) => Error;
type AdapterField = { readonly name: string; readonly type: string; readonly required: boolean; readonly nullable?: boolean };
type AdapterDescriptor = { readonly adapter: string; readonly fields: readonly AdapterField[] };

export function parseCommandAdapterPayload(descriptor: AdapterDescriptor, args: string): Record<string, unknown> {
  if (descriptor.adapter === "raw") return { raw: args };
  if (descriptor.adapter !== "id-json-object") throw new Error(`unknown command adapter ${descriptor.adapter}`);
  const fields = exactFields(descriptor.fields, [["id"], ["object"]], descriptor.adapter);
  const idField = fields[0];
  const objectField = fields[1];
  if (idField === undefined || objectField === undefined) throw new Error(`${descriptor.adapter} generated descriptor shape drift`);
  const trimmed = args.trim();
  const separator = trimmed.search(/\s/u);
  if (separator <= 0) throw new Error("id-json-object command requires an id followed by a JSON object");
  const id = trimmed.slice(0, separator);
  if (id.length === 0 || /[\\/\0]/u.test(id)) throw new Error(`id-json-object command id is malformed: ${id}`);
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed.slice(separator).trim()); } catch (error) { throw new Error(`id-json-object command object is not valid JSON: ${boundedDiagnostic(error)}`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("id-json-object command value must be a JSON object");
  return { [idField.name]: id, [objectField.name]: parsed };
}

function exactFields(fields: readonly AdapterField[], types: readonly (readonly string[])[], adapter: string): readonly AdapterField[] {
  if (fields.length !== types.length) throw new Error(`${adapter} generated descriptor shape drift`);
  fields.forEach((field, index) => { const allowed = types[index]; if (allowed === undefined || !field.required || field.nullable || !allowed.includes(field.type)) throw new Error(`${adapter} generated descriptor field drift at ${field.name}`); });
  return fields;
}

export function closedRecord(value: unknown, allowed: readonly string[], label: string, ErrorType: HostError = Error): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ErrorType(`${label} is not an object`);
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new ErrorType(`${label} contains unknown key ${key}`);
  }
  return value as Record<string, unknown>;
}

export function nonEmptyString(value: unknown, label: string, ErrorType: HostError = Error): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ErrorType(`${label} must be a non-empty string`);
}

export function boolValue(value: unknown, label: string, ErrorType: HostError = Error): boolean {
  if (typeof value === "boolean") return value;
  throw new ErrorType(`${label} must be boolean`);
}

export function nonNegativeInteger(value: unknown, label: string, ErrorType: HostError = Error): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new ErrorType(`${label} must be a non-negative integer`);
}

export function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string, ErrorType: HostError = Error): T[number] {
  const text = nonEmptyString(value, label, ErrorType);
  if ((values as readonly string[]).includes(text)) return text as T[number];
  throw new ErrorType(`${label} must be one of ${values.join(", ")}; got ${text}`);
}

export function boundedDiagnostic(error: unknown, max = 240): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function redactedEnv(deny: readonly string[], extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of deny) delete env[name];
  return { ...env, ...extra };
}
