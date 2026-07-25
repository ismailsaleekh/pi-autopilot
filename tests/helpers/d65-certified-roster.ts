import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAutopilotRoster } from '../../src/core/roster/contracts.ts';
import { parseRosterJsonWithDuplicateKeyRejection } from '../../src/core/roster/canonical.ts';

/**
 * The EXACT packaged W4-certified launch roster used by the D65 launch path.
 *
 * D65 launch authority is certification authority, not a hardcoded model list
 * (see `src/core/coordination/d65-launch-roster.ts`). Tests therefore bind to
 * the real certified roster bytes that ship in the package, so a fixture can
 * never pass a launch assertion that the production launch path would reject.
 */
const CERTIFIED_ROSTER_RELATIVE_PATH = 'artifacts/qualification/live/codex-gpt55-heavy/certified-roster.json';

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Load and parse the packaged certified launch roster. */
export function packagedCertifiedLaunchRoster(): ReturnType<typeof parseAutopilotRoster> {
  const bytes = readFileSync(resolve(packageRoot(), CERTIFIED_ROSTER_RELATIVE_PATH), 'utf8');
  return parseAutopilotRoster(parseRosterJsonWithDuplicateKeyRejection(bytes));
}
