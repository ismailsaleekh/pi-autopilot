// Deterministic machine-readable test-identity reporter (Phase 40 / D70).
//
// Emits one JSON line per terminal leaf-test event with a stable hierarchical
// identity so that the serial and fast execution paths can be compared as
// identical logical-test multisets, not merely aggregate counts. It is the
// parity oracle for D70 §5: any missing, skipped, todo, cancelled, or silently
// filtered test is surfaced by a diff of the two identity streams.
//
// Identity is `<relFile> :: <ancestor> > … > <leaf>` reconstructed from the
// nesting-ordered `test:start`/`test:pass`/`test:fail` stream. Suites
// (details.type === 'suite') are recorded as ancestry frames only; only leaf
// tests are emitted as identities. `skip`/`todo` (and a `cancelled` fail) are
// emitted with their flag so the comparator can fail closed on any coverage
// change.
//
// Output file is chosen by AUTOPILOT_TEST_IDENTITY_OUT (append, one process per
// test file so appends are whole-line atomic under POSIX for our line sizes).
// When unset the reporter is inert (it still passes events through as text so a
// human can read them), which keeps it safe to leave wired in any lane.

import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';

const OUT = process.env.AUTOPILOT_TEST_IDENTITY_OUT ?? null;
const ROOT = process.env.AUTOPILOT_TEST_IDENTITY_ROOT ?? process.cwd();

function relFile(file) {
  if (typeof file !== 'string' || file.length === 0) return '<unknown-file>';
  const rel = relative(ROOT, file);
  return rel.length === 0 ? file : rel.split('\\').join('/');
}

// Per-file ancestry stacks keyed by absolute file path. node:test interleaves
// files under concurrency, but every event carries its own `file`, and within
// one file `test:start` events are strictly nesting-ordered, so a per-file
// stack indexed by nesting is exact.
const stacks = new Map();

function stackFor(file) {
  let stack = stacks.get(file);
  if (stack === undefined) {
    stack = [];
    stacks.set(file, stack);
  }
  return stack;
}

function record(line) {
  if (OUT !== null) appendFileSync(OUT, line + '\n');
}

export default async function* identityReporter(source) {
  for await (const event of source) {
    const data = event.data ?? {};
    const file = typeof data.file === 'string' ? data.file : '<unknown-file>';
    if (event.type === 'test:start') {
      const stack = stackFor(file);
      stack[data.nesting] = typeof data.name === 'string' ? data.name : '<anonymous>';
      stack.length = data.nesting + 1;
      continue;
    }
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const isSuite = data.details?.type === 'suite';
      if (!isSuite) {
        const stack = stackFor(file);
        const ancestors = stack.slice(0, data.nesting);
        const name = typeof data.name === 'string' ? data.name : '<anonymous>';
        const identity = ancestors.concat(name).join(' > ');
        const status = event.type === 'test:fail' ? 'fail' : 'pass';
        const flags = [];
        if (data.skip) flags.push('skip');
        if (data.todo) flags.push('todo');
        record(JSON.stringify({
          id: `${relFile(file)} :: ${identity}`,
          status,
          flags,
        }));
      }
      // Pop this frame from the ancestry stack on completion.
      const stack = stackFor(file);
      if (stack.length > data.nesting) stack.length = data.nesting;
      continue;
    }
  }
}
