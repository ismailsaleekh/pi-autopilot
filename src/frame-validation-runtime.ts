type R = Record<string, unknown>;
type FieldDescriptor = {
  readonly name?: string;
  readonly kind?: string;
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly type?: string;
  readonly item_kind?: string;
  readonly item_type?: string;
  readonly route?: string;
  readonly field?: string;
  readonly min?: number;
  readonly max?: number;
  readonly unique_fields?: readonly string[];
};
type ShapeDescriptor = { readonly fields: readonly FieldDescriptor[] };
type RouteDescriptor = { readonly payload: string; readonly posture: string };
type ValidationDescriptors = {
  readonly routes: Record<string, RouteDescriptor | undefined>;
  readonly shapes: Record<string, ShapeDescriptor | undefined>;
  readonly enums: Record<string, readonly string[] | undefined>;
  readonly list_constraints: readonly FieldDescriptor[];
};
export class CoreFrameValidationError extends Error {
  constructor(message: string) { super(message); this.name = "CoreFrameValidationError"; }
}
export function validateCoreToHostFrameWithDescriptors(desc: ValidationDescriptors, value: unknown): unknown {
  const frame = closed(value, ["v", "id", "kind", "payload"], "core frame", ["v", "id", "kind", "payload"]);
  if (frame.v !== 1) bad("core frame v must be 1");
  const id = int(frame.id, "core frame id");
  const kind = text(frame.kind, "core frame kind"), route = desc.routes[kind];
  if (route === undefined) bad(`unsupported core frame kind: ${kind}`);
  if (route.posture === "unsupported") {
    bad(`unsupported core frame kind: ${kind} (generated seam posture unsupported)`);
  }
  const payload = shape(desc, route.payload, frame.payload, `${kind} payload`);
  lists(desc, kind, payload);
  return { v: 1, id, kind, payload };
}
export function validateBackgroundActionWithDescriptors(desc: ValidationDescriptors, value: unknown): unknown {
  return shape(desc, "BackgroundAction", value, "background action");
}
export function validateBgRunDescriptorIdentityWithDescriptors(desc: ValidationDescriptors, value: unknown): void {
  shape(desc, "BackgroundActionBgRun", value, "bg_run");
}
function shape(desc: ValidationDescriptors, name: string, value: unknown, label: string): R {
  const fields = desc.shapes[name]?.fields;
  if (fields === undefined) bad(`missing generated shape descriptor ${name}`);
  const req = fields.filter((field) => field.required).map((field) => needName(field));
  const rec = closed(value, fields.map(needName), label, req);
  for (const field of fields) {
    const name = needName(field);
    if (own(rec, name)) fieldValue(desc, field, rec[name], fieldLabel(label, name));
  }
  return rec;
}
function fieldValue(desc: ValidationDescriptors, field: FieldDescriptor, value: unknown, label: string): void {
  if (value === null) {
    if (field.nullable) return;
    if (label === "bg_run.timeoutSeconds") positive(value, label);
    bad(`${label} must not be null`);
  }
  if (field.kind === "shape") {
    const type = need(field, "type");
    shape(desc, type, value, nested(type, label));
  } else if (field.kind === "list") {
    listField(desc, field, value, label);
  } else scalar(desc, need(field, "type"), value, label);
}
function listField(desc: ValidationDescriptors, field: FieldDescriptor, value: unknown, label: string): void {
  for (const [index, item] of array(value, label).entries()) {
    const ty = need(field, "item_type"), itemLabel = `${label}[${index}]`;
    if (field.item_kind === "shape") shape(desc, ty, item, itemLabel);
    else scalar(desc, ty, item, itemLabel);
  }
}
function scalar(desc: ValidationDescriptors, type: string, value: unknown, label: string): void {
  const values = desc.enums[type] as readonly string[] | undefined;
  if (values !== undefined) return enumValue(type, values, value, label);
  if (type === "bool") bool(value, label);
  else if (type === "u8" || type === "u32" || type === "u64") integerByLabel(value, label);
  else if (type === "object" || type === "json") object(value, label);
  else text(value, label);
}
function enumValue(type: string, values: readonly string[], value: unknown, label: string): void {
  const got = text(value, label);
  if (values.includes(got)) return;
  if (type === "action_kind" && label === "background action kind") {
    bad(`unsupported background action kind: ${got}`);
  }
  bad(`${label} must be one of ${values.join(", ")}; got ${got}`);
}
function lists(desc: ValidationDescriptors, route: string, payload: R): void {
  for (const c of desc.list_constraints.filter((item) => item.route === route)) {
    const constraintField = c.field;
    if (constraintField === undefined) bad("generated list constraint is missing field");
    const label = `${route}.${constraintField}`, values = array(payload[constraintField], label);
    if (c.min === 1 && values.length === 0) bad(`${label} must be non-empty`);
    if (c.max !== undefined && values.length > c.max) bad(`${label} exceeds maximum ${c.max}`);
    for (const field of c.unique_fields ?? []) {
      unique(values.map((value) => text(object(value, label)[field], `${label}.${field}`)), `${route} ${field}`);
    }
  }
}
function closed(value: unknown, keys: readonly string[], label: string, req: readonly string[]): R {
  const rec = object(value, label), allowed = new Set(keys);
  for (const key of Object.keys(rec)) if (!allowed.has(key)) bad(`${label} contains unknown key ${key}`);
  for (const key of req) if (!own(rec, key)) bad(`${label} missing required key ${key}`);
  return rec;
}
function object(value: unknown, label: string): R {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as R;
  return bad(`${label} must be an object`);
}
function array(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  return bad(`${label} must be an array`);
}
function text(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  return bad(`${label} must be a non-empty string`);
}
function bool(value: unknown, label: string): void { if (typeof value !== "boolean") bad(`${label} must be boolean`); }
function integerByLabel(value: unknown, label: string): number {
  return label === "bg_run.timeoutSeconds" ? positive(value, label) : int(value, label);
}
function int(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return bad(`${label} must be a non-negative integer`);
}
function positive(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return bad(`${label} must be a positive integer`);
}
function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) { if (seen.has(value)) bad(`${label} must be unique: ${value}`); seen.add(value); }
}
function fieldLabel(parent: string, name: string): string {
  if (parent === "bg_run") return `bg_run.${name}`;
  return parent.endsWith(" payload") ? `${parent.slice(0, -8)}.${name}` : `${parent} ${name}`;
}
function nested(type: string, fallback: string): string {
  if (type === "BackgroundAction") return "background action";
  if (type === "BackgroundActionBgRun") return "bg_run";
  return fallback;
}
function need(field: FieldDescriptor, key: "type" | "item_type"): string {
  if (field[key] !== undefined) return field[key];
  return bad(`generated descriptor field ${field.name ?? "<unnamed>"} is missing ${key}`);
}
function needName(field: FieldDescriptor): string {
  if (field.name !== undefined) return field.name;
  return bad("generated descriptor field is missing name");
}
function own(record: R, key: string): boolean { return Object.prototype.hasOwnProperty.call(record, key); }
function bad(message: string): never { throw new CoreFrameValidationError(message); }
