// Strict, dependency-free frontmatter parser + serializer for the docs gate.
//
// The package ships zero runtime dependencies and its gate is offline/no-spend,
// so we do NOT pull a YAML library. Instead we accept a deliberately small,
// fully-specified subset of YAML that is sufficient for the frontmatter schema
// (docs-agent-first-restructure-and-freshness-qa-2026-07-20.md §5.1) and reject
// anything outside it LOUDLY (F.silent_fallback is banned). The serializer emits
// exactly the shape the parser accepts, so `--write` round-trips byte-stably.
//
// Supported value grammar (one line per key unless a block list/map is used):
//   key: <scalar>
//   key: [<scalar>, <scalar>, ...]     (inline empty/one-line list)
//   key:
//     - <scalar>                        (block list of scalars)
//     - key1: <scalar>                  (block list of one-line maps -> objects)
//       key2: <scalar>
//   key:
//     subkey: <scalar>                  (block map -> object)
// Scalars: unquoted string, 'single-quoted' string, integer, true/false/null.

const FRONTMATTER_FENCE = '---';

export class DocFrontmatterError extends Error {
  constructor(message, location) {
    super(location === undefined ? message : `${location}: ${message}`);
    this.name = 'DocFrontmatterError';
    this.location = location ?? null;
  }
}

/**
 * Split a markdown document into its frontmatter block and the body.
 * @returns {{ frontmatterText: string, body: string, hasFrontmatter: boolean }}
 */
export function splitFrontmatter(text, location) {
  if (!text.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return { frontmatterText: '', body: text, hasFrontmatter: false };
  }
  const closeIndex = text.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  if (closeIndex === -1) {
    // Tolerate a doc whose frontmatter fence closes at end-of-file without a body.
    const eofClose = text.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
    if (eofClose !== -1 && text.slice(eofClose + 1).trim() === FRONTMATTER_FENCE) {
      return {
        frontmatterText: text.slice(FRONTMATTER_FENCE.length + 1, eofClose),
        body: '',
        hasFrontmatter: true,
      };
    }
    throw new DocFrontmatterError('frontmatter opening fence is not closed by a line "---"', location);
  }
  return {
    frontmatterText: text.slice(FRONTMATTER_FENCE.length + 1, closeIndex + 1),
    body: text.slice(closeIndex + `\n${FRONTMATTER_FENCE}\n`.length),
    hasFrontmatter: true,
  };
}

function stripComment(line) {
  // Only strip a trailing comment introduced by " #" outside of quotes. Keys/values
  // in this schema never contain '#', so a conservative rule is safe and loud.
  let inSingle = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'") inSingle = !inSingle;
    else if (ch === '#' && !inSingle && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i).replace(/\s+$/u, '');
  }
  return line;
}

function parseScalar(raw, location) {
  const value = raw.trim();
  if (value.length === 0) {
    throw new DocFrontmatterError('empty scalar; use an explicit value, [] for empty list, or null', location);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new DocFrontmatterError(`unterminated single-quoted string: ${raw}`, location);
    }
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+$/u.test(value)) return Number.parseInt(value, 10);
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new DocFrontmatterError(`unterminated inline list: ${raw}`, location);
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitInlineList(inner, location).map((item) => parseScalar(item, location));
  }
  if (value.startsWith('{')) {
    throw new DocFrontmatterError('inline maps are not supported; use a block map', location);
  }
  return value;
}

function splitInlineList(inner, location) {
  const items = [];
  let current = '';
  let inSingle = false;
  for (const ch of inner) {
    if (ch === "'") inSingle = !inSingle;
    if (ch === ',' && !inSingle) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  const trimmed = items.map((item) => item.trim());
  if (trimmed.some((item) => item.length === 0)) {
    throw new DocFrontmatterError(`inline list has an empty element: [${inner}]`, location);
  }
  return trimmed;
}

function indentOf(line) {
  let count = 0;
  while (count < line.length && line[count] === ' ') count += 1;
  if (line[count] === '\t') {
    throw new DocFrontmatterError('tabs are not allowed in frontmatter indentation');
  }
  return count;
}

/**
 * Parse the frontmatter subset into a plain object.
 * @returns {Record<string, unknown>}
 */
export function parseFrontmatter(frontmatterText, location) {
  const rawLines = frontmatterText.replace(/\n$/u, '').split('\n');
  const lines = rawLines
    .map((line, index) => ({ text: stripComment(line), lineNumber: index + 1 }))
    .filter((entry) => entry.text.trim().length > 0);
  const result = {};
  let index = 0;

  function fail(message, lineNumber) {
    throw new DocFrontmatterError(`${message} (frontmatter line ${String(lineNumber)})`, location);
  }

  while (index < lines.length) {
    const line = lines[index];
    if (indentOf(line.text) !== 0) fail(`unexpected indentation for a top-level key: "${line.text}"`, line.lineNumber);
    const colon = line.text.indexOf(':');
    if (colon === -1) fail(`expected "key: value" but found: "${line.text}"`, line.lineNumber);
    const key = line.text.slice(0, colon).trim();
    if (key.length === 0) fail(`empty key in: "${line.text}"`, line.lineNumber);
    if (Object.prototype.hasOwnProperty.call(result, key)) fail(`duplicate key "${key}"`, line.lineNumber);
    const rest = line.text.slice(colon + 1).trim();
    index += 1;

    if (rest.length > 0) {
      result[key] = parseScalar(rest, location);
      continue;
    }

    // Block value: gather indented child lines.
    const childLines = [];
    while (index < lines.length && indentOf(lines[index].text) >= 2) {
      childLines.push(lines[index]);
      index += 1;
    }
    if (childLines.length === 0) fail(`key "${key}" has no value and no indented block`, line.lineNumber);
    result[key] = parseBlock(childLines, location, fail);
  }
  return result;
}

function parseBlock(childLines, location, fail) {
  const baseIndent = Math.min(...childLines.map((entry) => indentOf(entry.text)));
  const isList = childLines.some((entry) => indentOf(entry.text) === baseIndent && entry.text.trim().startsWith('- '));
  if (isList) return parseBlockList(childLines, baseIndent, location, fail);
  return parseBlockMap(childLines, baseIndent, location, fail);
}

function parseBlockList(childLines, baseIndent, location, fail) {
  const items = [];
  let current = null;
  for (const entry of childLines) {
    const indent = indentOf(entry.text);
    const content = entry.text.slice(indent);
    if (indent === baseIndent && content.startsWith('- ')) {
      const itemText = content.slice(2).trim();
      const colon = firstMapColon(itemText);
      if (colon === -1) {
        items.push(parseScalar(itemText, location));
        current = null;
      } else {
        current = {};
        addMapEntry(current, itemText, colon, location, fail, entry.lineNumber);
        items.push(current);
      }
    } else if (indent > baseIndent && current !== null && typeof current === 'object') {
      const colon = firstMapColon(content);
      if (colon === -1) fail(`expected "key: value" in list item continuation: "${content}"`, entry.lineNumber);
      addMapEntry(current, content, colon, location, fail, entry.lineNumber);
    } else {
      fail(`malformed block list line: "${entry.text}"`, entry.lineNumber);
    }
  }
  return items;
}

function parseBlockMap(childLines, baseIndent, location, fail) {
  const map = {};
  for (const entry of childLines) {
    const indent = indentOf(entry.text);
    if (indent !== baseIndent) fail(`inconsistent indentation in block map: "${entry.text}"`, entry.lineNumber);
    const content = entry.text.slice(indent);
    const colon = firstMapColon(content);
    if (colon === -1) fail(`expected "key: value" in block map: "${content}"`, entry.lineNumber);
    addMapEntry(map, content, colon, location, fail, entry.lineNumber);
  }
  return map;
}

function firstMapColon(text) {
  let inSingle = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") inSingle = !inSingle;
    else if (ch === ':' && !inSingle && (i + 1 >= text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function addMapEntry(map, text, colon, location, fail, lineNumber) {
  const key = text.slice(0, colon).trim();
  if (key.length === 0) fail(`empty key in: "${text}"`, lineNumber);
  if (Object.prototype.hasOwnProperty.call(map, key)) fail(`duplicate key "${key}"`, lineNumber);
  map[key] = parseScalar(text.slice(colon + 1), location);
}

// ---- Serialization (deterministic; round-trips with parseFrontmatter) --------

function serializeScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new DocFrontmatterError(`cannot serialize non-integer number: ${String(value)}`);
    return String(value);
  }
  if (typeof value !== 'string') throw new DocFrontmatterError(`cannot serialize value of type ${typeof value}`);
  if (needsQuoting(value)) return `'${value.replace(/'/gu, "''")}'`;
  return value;
}

function needsQuoting(value) {
  if (value.length === 0) return true;
  if (value === 'true' || value === 'false' || value === 'null') return true;
  if (/^-?\d+$/u.test(value)) return true;
  if (/^[[{'"]/u.test(value)) return true;
  if (/[:#]/u.test(value)) return true;
  if (value.trim() !== value) return true;
  return false;
}

/**
 * Serialize an ordered frontmatter object into the canonical block form the
 * parser accepts. `keyOrder` fixes emission order so the manifest and re-stamps
 * are byte-stable.
 */
export function serializeFrontmatter(record, keyOrder) {
  const keys = keyOrder ?? Object.keys(record);
  const lines = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const entries = Object.entries(item);
          entries.forEach(([mapKey, mapValue], entryIndex) => {
            const prefix = entryIndex === 0 ? '  - ' : '    ';
            lines.push(`${prefix}${mapKey}: ${serializeScalar(mapValue)}`);
          });
        } else {
          lines.push(`  - ${serializeScalar(item)}`);
        }
      }
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [mapKey, mapValue] of Object.entries(value)) {
        lines.push(`  ${mapKey}: ${serializeScalar(mapValue)}`);
      }
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`);
    }
  }
  return lines.join('\n');
}

/** Render a full markdown doc from frontmatter + body. */
export function composeDoc(frontmatterText, body) {
  const trimmedBody = body.startsWith('\n') ? body.slice(1) : body;
  return `${FRONTMATTER_FENCE}\n${frontmatterText}\n${FRONTMATTER_FENCE}\n\n${trimmedBody.replace(/^\n+/u, '')}`;
}
