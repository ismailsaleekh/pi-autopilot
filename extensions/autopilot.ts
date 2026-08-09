import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import autopilotExtension, { type AutopilotExtensionOptions } from "../src/extension.ts";

/**
 * Parent-session package entrypoint.
 *
 * Parent sessions never register child terminal descriptors. Each spawned
 * child receives exactly one profile-selected descriptor through the generated
 * child add-on loaded with `-e`.
 */
export default function autopilot(pi: ExtensionAPI, options: AutopilotExtensionOptions = {}): void {
  autopilotExtension(pi, options);
}
