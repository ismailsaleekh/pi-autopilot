import { CoordinationRuntimeError } from './failures.ts';

function compareCanonicalKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeCanonicalJson(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CoordinationRuntimeError('invalid-request', 'canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new CoordinationRuntimeError('invalid-request', 'canonical JSON accepts only JSON values');
  if (ancestors.has(value)) throw new CoordinationRuntimeError('invalid-request', 'canonical JSON rejects cyclic values');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new CoordinationRuntimeError('invalid-request', 'canonical JSON rejects sparse arrays');
        entries.push(encodeCanonicalJson(value[index], ancestors));
      }
      return `[${entries.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CoordinationRuntimeError('invalid-request', 'canonical JSON rejects non-plain objects');
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort(compareCanonicalKeys);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeCanonicalJson(record[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** RFC-8259 JSON with recursively sorted object keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return encodeCanonicalJson(value, new WeakSet<object>());
}
