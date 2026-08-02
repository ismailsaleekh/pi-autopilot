import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const packageRoot = new URL('../../', import.meta.url);

interface Slot {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly route: string;
  readonly roles: readonly string[];
}

interface Pool {
  readonly provider: string;
  readonly model: string;
  readonly max: number;
}

function source(relPath: string): string {
  return readFileSync(new URL(relPath, packageRoot), 'utf8');
}

function field(body: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s+"([^"]+)"`, 'u').exec(body);
  if (match === null) throw new Error(`missing ${name}`);
  const value = match[1];
  if (value === undefined) throw new Error(`missing ${name} capture`);
  return value;
}

function fields(body: string, name: string): readonly string[] {
  const match = new RegExp(`\\b${name}((?:\\s+"[^"]+")+)`, 'u').exec(body);
  if (match === null) throw new Error(`missing ${name}`);
  const values = match[1]?.match(/"([^"]+)"/gu) ?? [];
  return values.map((quoted) => quoted.slice(1, -1));
}

function slots(): readonly Slot[] {
  const text = source('data/roster.kdl');
  return [...text.matchAll(/slot\s+"([^"]+)"\s*\{([\s\S]*?)\}/gu)].map((match) => {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) throw new Error('malformed slot');
    return {
      name,
      provider: field(body, 'provider'),
      model: field(body, 'model'),
      thinking: field(body, 'thinking'),
      route: field(body, 'route'),
      roles: fields(body, 'roles'),
    };
  });
}

function pools(): readonly Pool[] {
  const text = source('data/concurrency.kdl');
  return [...text.matchAll(/pool\s+"([^"]+)"\s*\{([\s\S]*?)\}/gu)].map((match) => {
    const body = match[2];
    if (body === undefined) throw new Error('malformed pool');
    const maxText = field(body, 'max');
    const max = Number.parseInt(maxText, 10);
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error(`invalid max ${maxText}`);
    return { provider: field(body, 'provider'), model: field(body, 'model'), max };
  });
}

void describe('current package roster authority', () => {
  void it('keeps every current roster slot on the subscription Codex route before spend', () => {
    const allSlots = slots();
    assert.equal(allSlots.length, 5);
    for (const slot of allSlots) {
      assert.equal(slot.provider, 'openai-codex', `${slot.name} provider`);
      assert.equal(slot.route, 'subscription', `${slot.name} route`);
      assert.match(slot.model, /^gpt-5\.(?:5|6-(?:sol|terra))$/u, `${slot.name} model`);
      assert.match(slot.thinking, /^(?:high|xhigh)$/u, `${slot.name} thinking`);
      assert.ok(slot.roles.length > 0, `${slot.name} must carry at least one role`);
    }
  });

  void it('keeps each rostered provider/model backed by an explicit positive concurrency pool', () => {
    const poolKeys = new Map(pools().map((pool) => [`${pool.provider}/${pool.model}`, pool.max]));
    for (const slot of slots()) {
      const key = `${slot.provider}/${slot.model}`;
      assert.equal(poolKeys.has(key), true, `${slot.name} has no concurrency pool ${key}`);
      assert.ok((poolKeys.get(key) ?? 0) > 0, `${slot.name} has non-positive concurrency pool ${key}`);
    }
  });

  void it('documents roster surfaces in generated docs and command docs', () => {
    const generated = source('docs/generated/roster.md');
    for (const slot of slots()) {
      assert.match(generated, new RegExp(`\\| ${slot.name} \\| ${slot.provider} \\| ${slot.model} \\| ${slot.thinking} \\| ${slot.route} \\|`, 'u'));
    }
    const commandDoc = source('docs/commands/autopilot.md');
    assert.match(commandDoc, /subscription Codex route before spend|Codex Responses/u);
    assert.match(commandDoc, /no silent fallback/u);
  });
});
