# adapters/pi-session

## Chosen Pi surface

The worker is outside Pi, so `pi-background-tasks` tools/EventBus are not an
available worker-side API. They also add task status, output-cap failure, and
completion-delivery policy that would create a second scheduler. This adapter
therefore uses the installed Pi CLI directly through the process primitive.

Launch is shell-free `pi --mode json` with an exact provider, model, thinking
level, deterministic `--session-id`, private `--session-dir`, disabled ambient
resource discovery, no launch-time extensions, exact built-in tools, and an
`@prompt-file` argument (prompt bytes never enter argv). The current frozen
contract cannot prove that an extension does not replace a provider, endpoint,
or model catalog, so every non-empty `extensionPaths` binding fails closed. JSON
stdout is bounded physical output
and is deliberately never parsed for "finished" meaning. Pi exits when its own
single-shot run settles; the adapter reports only process lifecycle plus files
found on disk. Launch atomically installs a bounded canonical process descriptor
in CAS and reads the exact bytes back before acknowledging. Inspect and fence
load that descriptor after a worker restart, verify the persisted child/run/epoch
and kernel birth marker, and fail closed on PID reuse or an unobservable process.
The in-process handle is never recovery authority.

Before launch, a managed `pi auth check --provider … --model … --json
--no-refresh` process must return the exact OAuth-ready record for an exact
runtime-pinned subscription route. The child and probe receive the same strict,
case-normalized environment and isolated `PI_CODING_AGENT_DIR`. That directory
must be non-symlinked/private and contain only private `auth.json` plus the exact
hardened settings (project trust, telemetry, retries, and compaction disabled);
`models.json`, proxy variables, endpoint overrides, API keys, OpenRouter, and
ambient config are refused. There is no paid/metered fallback.

`PiSessionAdapter` fails closed unless its constructor receives an explicit
route verifier, and it rejects a successful verifier observation unless its
provider/model exactly equal the launch binding. The verifier in turn requires a
structural cancellable deadline
capability; it owns no timer. Completed probes cancel their deadline immediately,
and timed-out or descendant-bearing probes are group-fenced.

The session file list/path and exact process observation are adapter-specific
physical observations because the frozen child observation currently has no
fields for either. Compaction, send-prompt, and resume are not improvised: the
frozen contract has no such intents. Contract amendment requests are recorded
in the L7 closure report.
