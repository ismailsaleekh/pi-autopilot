import { createHash } from 'node:crypto';
export const AUTOPILOT_ROSTER_CANONICAL_HASH_ALGORITHM = 'autopilot.phase37.canonical-json.sha256.v1';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const WHITESPACE = new Set([' ', '\n', '\r', '\t']);
export class AutopilotRosterCanonicalizationError extends Error {
    issues;
    constructor(issues) {
        super(`Autopilot roster canonicalization failed: ${issues.join('; ')}`);
        this.name = 'AutopilotRosterCanonicalizationError';
        this.issues = issues;
    }
}
export function assertRosterSha256Digest(value) {
    if (!SHA256_PATTERN.test(value)) {
        throw new AutopilotRosterCanonicalizationError([
            `digest ${JSON.stringify(value)} must match sha256:<64 lowercase hex>`,
        ]);
    }
}
export function parseRosterJsonWithDuplicateKeyRejection(text) {
    assertNoDuplicateJsonObjectKeys(text);
    return JSON.parse(text);
}
export function canonicalRosterJson(value) {
    return `${canonicalizeJsonValue(value, '$')}\n`;
}
export function rosterCanonicalSha256(value) {
    return sha256Utf8(canonicalRosterJson(value));
}
export function rosterCanonicalSha256Hex(value) {
    return rosterCanonicalSha256(value).slice('sha256:'.length);
}
export function rosterCanonicalSha256OmittingOwnFields(value, omittedFields) {
    return rosterCanonicalSha256(omitOwnFields(value, omittedFields));
}
export function rosterCanonicalSha256OmittingOwnField(value, omittedField) {
    return rosterCanonicalSha256OmittingOwnFields(value, [omittedField]);
}
export function sha256Utf8(text) {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
export function sha256Bytes(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
export function assertNoDuplicateJsonObjectKeys(text) {
    const issues = [];
    const stack = [];
    let index = 0;
    let rootComplete = false;
    const currentFrame = () => stack[stack.length - 1];
    const fail = (message) => {
        issues.push(`${message} at byte ${String(index)}`);
    };
    const skipWhitespace = () => {
        while (index < text.length && WHITESPACE.has(text[index] ?? ''))
            index += 1;
    };
    const afterValue = () => {
        const frame = currentFrame();
        if (frame === undefined) {
            rootComplete = true;
            return;
        }
        if (frame.kind === 'object') {
            if (frame.expect !== 'value')
                fail('object value appeared outside a property value position');
            frame.expect = 'commaOrEnd';
            return;
        }
        if (frame.expect !== 'valueOrEnd')
            fail('array value appeared outside an array value position');
        frame.expect = 'commaOrEnd';
    };
    const closeContainer = (kind) => {
        const frame = currentFrame();
        if (frame === undefined || frame.kind !== kind) {
            fail(`unexpected ${kind === 'object' ? '}' : ']'}`);
            return;
        }
        stack.pop();
        index += 1;
        afterValue();
    };
    const parseStringToken = () => {
        const start = index;
        index += 1;
        while (index < text.length) {
            const char = text[index];
            if (char === undefined)
                break;
            if (char === '"') {
                index += 1;
                try {
                    const parsed = JSON.parse(text.slice(start, index));
                    if (typeof parsed !== 'string') {
                        fail('JSON string token did not parse as string');
                        return null;
                    }
                    return parsed;
                }
                catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    fail(`invalid JSON string token: ${detail}`);
                    return null;
                }
            }
            if (char === '\\') {
                index += 1;
                if (index >= text.length) {
                    fail('unterminated JSON escape');
                    return null;
                }
            }
            index += 1;
        }
        fail('unterminated JSON string');
        return null;
    };
    const parseLiteral = (literal) => {
        if (text.slice(index, index + literal.length) !== literal) {
            fail(`expected literal ${literal}`);
            index += 1;
            return;
        }
        index += literal.length;
        afterValue();
    };
    const parseNumber = () => {
        const start = index;
        if (text[index] === '-')
            index += 1;
        if (text[index] === '0') {
            index += 1;
        }
        else if (isDigitOneToNine(text[index])) {
            index += 1;
            while (isDigit(text[index]))
                index += 1;
        }
        else {
            fail('invalid JSON number integer part');
            return;
        }
        if (text[index] === '.') {
            index += 1;
            if (!isDigit(text[index])) {
                fail('invalid JSON number fraction part');
                return;
            }
            while (isDigit(text[index]))
                index += 1;
        }
        if (text[index] === 'e' || text[index] === 'E') {
            index += 1;
            if (text[index] === '+' || text[index] === '-')
                index += 1;
            if (!isDigit(text[index])) {
                fail('invalid JSON number exponent part');
                return;
            }
            while (isDigit(text[index]))
                index += 1;
        }
        const raw = text.slice(start, index);
        const parsed = Number(raw);
        if (!Number.isFinite(parsed))
            fail('JSON number must be finite');
        afterValue();
    };
    const beginValue = () => {
        const frame = currentFrame();
        if (rootComplete) {
            fail('unexpected non-whitespace after the root JSON value');
            index += 1;
            return;
        }
        if (frame?.kind === 'object' && frame.expect !== 'value') {
            fail('object is not expecting a value');
            index += 1;
            return;
        }
        if (frame?.kind === 'array' && frame.expect !== 'valueOrEnd') {
            fail('array is not expecting a value');
            index += 1;
            return;
        }
        const char = text[index];
        if (char === '{') {
            stack.push({ kind: 'object', keys: new Set(), expect: 'keyOrEnd' });
            index += 1;
            return;
        }
        if (char === '[') {
            stack.push({ kind: 'array', expect: 'valueOrEnd' });
            index += 1;
            return;
        }
        if (char === '"') {
            parseStringToken();
            afterValue();
            return;
        }
        if (char === 't') {
            parseLiteral('true');
            return;
        }
        if (char === 'f') {
            parseLiteral('false');
            return;
        }
        if (char === 'n') {
            parseLiteral('null');
            return;
        }
        if (char === '-' || isDigit(char)) {
            parseNumber();
            return;
        }
        fail('expected JSON value');
        index += 1;
    };
    while (index < text.length && issues.length === 0) {
        skipWhitespace();
        if (index >= text.length)
            break;
        const frame = currentFrame();
        if (frame === undefined) {
            beginValue();
            continue;
        }
        const char = text[index];
        if (frame.kind === 'object') {
            if (frame.expect === 'keyOrEnd') {
                if (char === '}') {
                    closeContainer('object');
                    continue;
                }
                if (char !== '"') {
                    fail('expected object key string or end');
                    break;
                }
                const key = parseStringToken();
                if (key !== null) {
                    if (frame.keys.has(key))
                        fail(`duplicate object member ${JSON.stringify(key)}`);
                    frame.keys.add(key);
                    frame.expect = 'colon';
                }
                continue;
            }
            if (frame.expect === 'colon') {
                if (char !== ':') {
                    fail('expected colon after object key');
                    break;
                }
                frame.expect = 'value';
                index += 1;
                continue;
            }
            if (frame.expect === 'value') {
                beginValue();
                continue;
            }
            if (frame.expect === 'commaOrEnd') {
                if (char === ',') {
                    frame.expect = 'keyOrEnd';
                    index += 1;
                    continue;
                }
                if (char === '}') {
                    closeContainer('object');
                    continue;
                }
                fail('expected comma or object end');
                break;
            }
        }
        if (frame.expect === 'valueOrEnd') {
            if (char === ']') {
                closeContainer('array');
                continue;
            }
            beginValue();
            continue;
        }
        if (char === ',') {
            frame.expect = 'valueOrEnd';
            index += 1;
            continue;
        }
        if (char === ']') {
            closeContainer('array');
            continue;
        }
        fail('expected comma or array end');
    }
    if (issues.length === 0) {
        skipWhitespace();
        if (stack.length > 0)
            issues.push('unterminated JSON container');
        if (!rootComplete)
            issues.push('missing root JSON value');
        if (index < text.length)
            issues.push(`unexpected trailing bytes at byte ${String(index)}`);
    }
    if (issues.length > 0)
        throw new AutopilotRosterCanonicalizationError(issues);
}
function canonicalizeJsonValue(value, path) {
    if (value === null)
        return 'null';
    const valueType = typeof value;
    if (valueType === 'string')
        return JSON.stringify(value);
    if (valueType === 'boolean')
        return value === true ? 'true' : 'false';
    if (valueType === 'number') {
        if (!Number.isFinite(value)) {
            throw new AutopilotRosterCanonicalizationError([`${path} must not be a non-finite number`]);
        }
        const encoded = JSON.stringify(value);
        if (encoded === undefined) {
            throw new AutopilotRosterCanonicalizationError([`${path} could not be encoded as JSON number`]);
        }
        return encoded;
    }
    if (valueType === 'undefined') {
        throw new AutopilotRosterCanonicalizationError([`${path} must not be undefined`]);
    }
    if (valueType === 'bigint' || valueType === 'symbol' || valueType === 'function') {
        throw new AutopilotRosterCanonicalizationError([`${path} has unsupported JSON type ${valueType}`]);
    }
    if (Array.isArray(value)) {
        const parts = [];
        for (let itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
            if (!Object.prototype.hasOwnProperty.call(value, itemIndex)) {
                throw new AutopilotRosterCanonicalizationError([`${path}[${String(itemIndex)}] is a sparse array hole`]);
            }
            parts.push(canonicalizeJsonValue(value[itemIndex], `${path}[${String(itemIndex)}]`));
        }
        return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(value)) {
        throw new AutopilotRosterCanonicalizationError([`${path} must be a plain JSON object`]);
    }
    const record = value;
    const keys = Object.keys(record).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const entries = keys.map((key) => {
        const entry = record[key];
        if (entry === undefined) {
            throw new AutopilotRosterCanonicalizationError([`${path}/${key} must not be undefined`]);
        }
        return `${JSON.stringify(key)}:${canonicalizeJsonValue(entry, `${path}/${key}`)}`;
    });
    return `{${entries.join(',')}}`;
}
function omitOwnFields(value, omittedFields) {
    if (!isPlainObject(value)) {
        throw new AutopilotRosterCanonicalizationError(['hash preimage must be a plain JSON object']);
    }
    const omitted = new Set(omittedFields);
    const output = {};
    for (const key of Object.keys(value)) {
        if (omitted.has(key))
            continue;
        const entry = value[key];
        if (entry === undefined) {
            throw new AutopilotRosterCanonicalizationError([`${key} must not be undefined`]);
        }
        output[key] = toJsonValue(entry, key);
    }
    return output;
}
function toJsonValue(value, path) {
    canonicalizeJsonValue(value, path);
    return value;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function isDigit(value) {
    return value !== undefined && value >= '0' && value <= '9';
}
function isDigitOneToNine(value) {
    return value !== undefined && value >= '1' && value <= '9';
}
