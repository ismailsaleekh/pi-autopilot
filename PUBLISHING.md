# Publishing pi-autopilot

Publish only an exact clean package candidate paired with `pi-background-tasks@2.1.2`. A green source checkout without rebuilt shipped binaries, deterministic tarballs, installed-consumer proof, and the SMF-named certificate is not publishable.

## Pre-publish sequence

From clean candidate roots, with no metered credentials and no network:

1. In `pi-background-tasks`: `npm run test`.
2. In `pi-autopilot`: regenerate code/docs if needed, then run typecheck, host-thinness, kernel-purity, no-inference, gate selftest, binary parity, launch-entrypoint, focused Rust, full Rust, Host tests, runtime integration, payload check, and pack dry-run.
3. Create two independent `npm pack --ignore-scripts` tarballs for each package and require byte-identical SHA-256 within each package.
4. Install both tarballs into a generic temporary consumer, add only local Pi peer packages/symlinks needed for the offline SDK, and rerun the four-path runtime integration against installed package directories.
5. Write `/tmp/smf-resolution/autopilot-runtime-repair-cert.v1.json` with format `pi-autopilot.runtime-repair-certificate.v1` and `status: PASS`.

The helper command is:

```bash
node scripts/certify-runtime-repair.mjs \
  --autopilot-root /absolute/path/to/pi-autopilot \
  --background-root /absolute/path/to/pi-background-tasks \
  --evidence-dir /absolute/external/evidence-dir
```

## Payload requirements

The npm payload must include:

- `src/` Host runtime sources and generated seam types;
- `bin/autopilot-core.mjs` and `bin/autopilot-agent-run.mjs`;
- `binaries/MANIFEST.json` and all supported platform binaries;
- `docs/generated/`, `AUTOPILOT-INSTRUCTIONS.md`, `README.md`, `LICENSE`, and `logo.png`.

It must exclude tests, private runtime state, `.pi`, `target/`, package tarballs, transcripts, plans, and any path still dispositioned as `delete` in `retain-port-delete.yaml`.

## Root project pinning

After package certification, the superproject still must be updated by an operator-owned clean commit that pins both package gitlinks and `.pi/settings.json` to the local Autopilot source:

```json
{
  "packages": [
    { "source": "../packages/pi-background-tasks", "extensions": [] },
    { "source": "../packages/pi-autopilot", "extensions": [] }
  ]
}
```

Do not claim the SMF authority seal is closed until the root checkout is clean, both submodules are pinned to the certified OIDs, and the SMF validator accepts the certificate and settings bytes.

## Prohibited release shortcuts

- No paid/metered model or API route.
- No external network in package certification lanes.
- No PATH/cwd/source-tree fallback for `autopilot-agent-run`.
- No fake Pi `ctx.bg_run` context.
- No stale binary manifest, source-hash waiver, or skipped `gate:launch-entrypoint` status-frame proof.
- No skipped/todo runtime integration.
