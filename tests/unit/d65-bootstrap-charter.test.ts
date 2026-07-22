import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseD65BootstrapCharter,
  reconstructD65BootstrapCharter,
} from '../../src/core/coordination/d65-bootstrap-charter.ts';
import { d65BootstrapCharterFixture } from '../helpers/d65-graph-charter-fixture.ts';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authority() {
  const charter = d65BootstrapCharterFixture();
  const event = charter['attach_event'];
  const result = charter['attach_result'];
  if (!isRecord(event) || !isRecord(result)) throw new Error('invalid test charter');
  const eventRow = event;
  return {
    charter,
    event: eventRow,
    result: {
      repo_id: String(eventRow['repo_id']), idempotency_key: String(eventRow['idempotency_key']), request_sha256: String(eventRow['request_sha256']), committed_event_seq: Number(eventRow['event_seq']),
      payload: { ...result, event_type: eventRow['event_type'], entity_type: eventRow['entity_type'], entity_id: eventRow['entity_id'] },
    },
  };
}

describe('D65 bootstrap charter reconstruction', () => {
  it('reconstructs the exact immutable charter from B event/result authority', () => {
    const input = authority();
    assert.deepEqual(reconstructD65BootstrapCharter({ event: input.event, result: input.result }), parseD65BootstrapCharter(input.charter));
  });

  it('rejects a broken event/result join and forged duplicate charter row', () => {
    const input = authority();
    assert.throws(
      () => reconstructD65BootstrapCharter({ event: input.event, result: { ...input.result, request_sha256: `sha256:${'0'.repeat(64)}` } }),
      /event\/result join identity is not exact/u,
    );
    const parsed = parseD65BootstrapCharter(input.charter);
    assert.throws(
      () => parseD65BootstrapCharter({ ...input.charter, run: { ...parsed.run, autopilot_id: 'forged' } }),
      /run differs between duplicated immutable bootstrap authority/u,
    );
  });

  it('rejects generic event metadata inside attach_result authority', () => {
    const input = authority();
    const payload = input.result.payload;
    if (!isRecord(payload)) throw new Error('invalid test attach payload');
    assert.throws(
      () => reconstructD65BootstrapCharter({ event: input.event, result: { ...input.result, payload: { ...payload, entity_id: 'other-run' } } }),
      /metadata differs from attach event authority/u,
    );
  });
});
