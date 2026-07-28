# Testing pi-autopilot

Use offline package-local commands from `packages/pi-autopilot`:

```bash
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1
npm run typecheck
npm run codegen:check
npm run gate:host-thinness
npm run gate:kernel-purity
npm run gate:no-inference
npm run gate:selftest
npm run gate:binary-parity
npm run test:rust
npm run test:host
PI_BACKGROUND_TASKS_PACKAGE_ROOT="$PWD/../pi-background-tasks" npm run test:runtime-integration
npm run payload:check
npm pack --dry-run --ignore-scripts
```

`npm run test` is the package-local default Rust/Host gate: typecheck, real-producer gate, binary parity, Rust tests, and Host tests. Runtime pairing and payload certification are explicit release lanes and should be run in the same candidate proof.

## Runtime integration requirements

`test:runtime-integration` never skips. It requires `PI_BACKGROUND_TASKS_PACKAGE_ROOT` and uses:

- `DefaultResourceLoader`, `createAgentSession`, `SessionManager.inMemory`, and a shared `createEventBus()`;
- the real Autopilot extension and the real background-tasks extension factory;
- a disposable Git repository and temp Pi agent directory;
- a fake local `pi` executable ahead of `PATH`;
- metered credential variables removed from the child environment.

The test invokes the slash command only inside the isolated harness. It is not approval to run the live/root SMF Autopilot command.

## Rebuilding binaries

After any Rust source change, rebuild every supported shipped binary and regenerate `binaries/MANIFEST.json` before running `gate:binary-parity`. The manifest source hash is the gate-computed SHA-256 over tracked `kernel/`, `drivers/`, and `codegen/` Rust files.

## Paired certificate

Run the release certificate driver only on clean package candidate roots:

```bash
node scripts/certify-runtime-repair.mjs \
  --autopilot-root "$PWD" \
  --background-root "$PWD/../pi-background-tasks" \
  --evidence-dir /tmp/pi-autopilot-runtime-evidence
```

The driver refuses metered credentials, records command/report hashes for the SMF validator ledger, creates two byte-identical tarballs for each package, installs the pair into a generic temp consumer, reruns the four-path SDK runtime test against installed package paths, and writes `/tmp/smf-resolution/autopilot-runtime-repair-cert.v1.json`.
