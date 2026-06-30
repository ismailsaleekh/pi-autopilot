import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendAutopilotEventRow,
  readAutopilotEventsIfPresent,
  readAutopilotResumeSnapshot,
  validateAutopilotStateReferences,
  writeAutopilotStateAtomic,
} from '../../src/core/state-store/index.ts';
import type { AutopilotEventRow, AutopilotState } from '../../src/core/contracts/types.ts';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-state-store-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  const emptyUnits: Record<string, never> = {};
  const base: AutopilotState = {
    schema_version: 'autopilot.state.v1',
    workstream: 'test-ws',
    updated_at: '2026-06-29T00:00:00.000Z',
    status: 'running',
    context_gate: { gate: 'ok', percent: null },
    last_event_id: 0,
    ready_queue: [],
    running: [],
    blocked: [],
    completed: [],
    units: emptyUnits,
    operator_questions: [],
    next_actions: [],
  };
  return { ...base, ...overrides };
}

function makeEvent(id: number, overrides: Partial<AutopilotEventRow> = {}): AutopilotEventRow {
  const base: AutopilotEventRow = {
    schema_version: 'autopilot.event.v1',
    id,
    ts: '2026-06-29T00:00:00.000Z',
    event: 'state_created',
    workstream: 'test-ws',
    summary: 'test event',
  };
  return { ...base, ...overrides };
}

async function assertRejects(
  block: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await block();
    throw new Error('expected rejection');
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }
    assert.match(err.message, pattern);
  }
}

void describe('Autopilot state-store', () => {
  void it('writes state atomically and reads it back', async () => {
    await withTempDir(async (dir) => {
      const state = makeState();
      const statePath = join(dir, 'state.json');
      await writeAutopilotStateAtomic({ statePath, state, validateReferences: false });
      const raw = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
      assert.equal(
        (raw as Record<string, unknown>)['schema_version'],
        'autopilot.state.v1',
      );
      assert.equal((raw as Record<string, unknown>)['workstream'], 'test-ws');
    });
  });

  void it('appends events append-only and enforces monotonic ids', async () => {
    await withTempDir(async (dir) => {
      const eventsPath = join(dir, 'events.jsonl');
      await appendAutopilotEventRow({ eventsPath, event: makeEvent(1) });
      await appendAutopilotEventRow({ eventsPath, event: makeEvent(2) });

      const content = await readFile(eventsPath, 'utf8');
      const lines = content.trim().split('\n');
      assert.equal(lines.length, 2);
      const first = lines[0];
      const second = lines[1];
      if (first === undefined || second === undefined) {
        throw new Error('expected two event lines');
      }
      assert.equal(JSON.parse(first)['id'], 1);
      assert.equal(JSON.parse(second)['id'], 2);

      await assertRejects(
        () => appendAutopilotEventRow({ eventsPath, event: makeEvent(4) }),
        /event-id-not-monotonic/u,
      );
    });
  });

  void it('preserves existing event rows on append', async () => {
    await withTempDir(async (dir) => {
      const eventsPath = join(dir, 'events.jsonl');
      await appendAutopilotEventRow({
        eventsPath,
        event: makeEvent(1, { summary: 'first' }),
      });
      await appendAutopilotEventRow({
        eventsPath,
        event: makeEvent(2, { summary: 'second' }),
      });

      const events = await readAutopilotEventsIfPresent(eventsPath);
      assert.equal(events.length, 2);
      const first = events[0];
      const second = events[1];
      if (first === undefined || second === undefined) {
        throw new Error('expected two events');
      }
      assert.equal(first.summary, 'first');
      assert.equal(second.summary, 'second');
    });
  });

  void it('resumes snapshot with state and bounded event tail', async () => {
    await withTempDir(async (dir) => {
      const state = makeState({ last_event_id: 3 });
      const statePath = join(dir, 'state.json');
      const eventsPath = join(dir, 'events.jsonl');

      await writeAutopilotStateAtomic({ statePath, state, validateReferences: false });
      await appendAutopilotEventRow({ eventsPath, event: makeEvent(1) });
      await appendAutopilotEventRow({ eventsPath, event: makeEvent(2) });
      await appendAutopilotEventRow({ eventsPath, event: makeEvent(3) });

      const snapshot = await readAutopilotResumeSnapshot({
        root: dir,
        statePath,
        eventsPath,
        eventTailLimit: 2,
        validateReferences: false,
      });

      assert.equal(snapshot.state.last_event_id, 3);
      assert.equal(snapshot.eventsTail.length, 2);
      const first = snapshot.eventsTail[0];
      const second = snapshot.eventsTail[1];
      if (first === undefined || second === undefined) {
        throw new Error('expected two tail events');
      }
      assert.equal(first.id, 2);
      assert.equal(second.id, 3);
    });
  });

  void it('never reads a sibling legacy runtime by default', async () => {
    await withTempDir(async (dir) => {
      const autopilotRoot = join(dir, '.pi', 'autopilot', 'test-ws');
      const legacyRoot = join(dir, '.pi', 'legacy-runtime', 'test-ws');
      await mkdir(autopilotRoot, { recursive: true });
      await mkdir(legacyRoot, { recursive: true });

      const autopilotState = makeState({ status: 'running' });
      const legacyState = makeState({ status: 'completed' });

      await writeAutopilotStateAtomic({
        statePath: join(autopilotRoot, 'state.json'),
        state: autopilotState,
        validateReferences: false,
      });
      await writeAutopilotStateAtomic({
        statePath: join(legacyRoot, 'state.json'),
        state: legacyState,
        validateReferences: false,
      });

      const snapshot = await readAutopilotResumeSnapshot({
        root: autopilotRoot,
        validateReferences: false,
      });
      assert.equal(snapshot.state.status, 'running');
    });
  });

  void it('rejects relative artifact root during reference validation', async () => {
    const state = makeState();
    await assertRejects(
      () => validateAutopilotStateReferences({ state, artifactRoot: 'relative/path' }),
      /invalid-artifact-root/u,
    );
  });

  void it('rejects relative runtime root on resume', async () => {
    await assertRejects(
      () => readAutopilotResumeSnapshot({ root: 'relative/path', validateReferences: false }),
      /invalid-artifact-root/u,
    );
  });

  void it('rejects traversal in reference paths', async () => {
    await withTempDir(async (dir) => {
      const state = makeState({
        units: {
          u01: {
            unit_id: 'u01',
            role: 'implement',
            state: 'completed',
            attempt: 1,
            spec_ref: '../evil.json',
            summary: 'bad ref',
          },
        },
      });
      await assertRejects(
        () => validateAutopilotStateReferences({ state, artifactRoot: dir }),
        /traversal segments/u,
      );
    });
  });

  void it('rejects absolute reference paths', async () => {
    await withTempDir(async (dir) => {
      const state = makeState({
        units: {
          u01: {
            unit_id: 'u01',
            role: 'implement',
            state: 'completed',
            attempt: 1,
            spec_ref: '/etc/passwd',
            summary: 'bad ref',
          },
        },
      });
      await assertRejects(
        () => validateAutopilotStateReferences({ state, artifactRoot: dir }),
        /not absolute/u,
      );
    });
  });

  void it('rejects corrupt events.jsonl', async () => {
    await withTempDir(async (dir) => {
      const eventsPath = join(dir, 'events.jsonl');
      await writeFile(eventsPath, 'not-json\n', 'utf8');
      await assertRejects(
        () => readAutopilotEventsIfPresent(eventsPath),
        /corrupt-events-jsonl/u,
      );
    });
  });

  void it('rejects non-monotonic event ids in existing jsonl', async () => {
    await withTempDir(async (dir) => {
      const eventsPath = join(dir, 'events.jsonl');
      await writeFile(
        eventsPath,
        `${JSON.stringify(makeEvent(2))}\n${JSON.stringify(makeEvent(1))}\n`,
        'utf8',
      );
      await assertRejects(
        () => readAutopilotEventsIfPresent(eventsPath),
        /corrupt-events-jsonl/u,
      );
    });
  });

  void it('rejects state-event id mismatch on resume', async () => {
    await withTempDir(async (dir) => {
      const state = makeState({ last_event_id: 2 });
      const statePath = join(dir, 'state.json');
      const eventsPath = join(dir, 'events.jsonl');

      await writeAutopilotStateAtomic({ statePath, state, validateReferences: false });
      await appendAutopilotEventRow({ eventsPath, event: makeEvent(1) });

      await assertRejects(
        () =>
          readAutopilotResumeSnapshot({
            root: dir,
            statePath,
            eventsPath,
            validateReferences: false,
          }),
        /state-event-id-mismatch/u,
      );
    });
  });
});
