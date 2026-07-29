import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import autopilotExtension, { type AutopilotExtensionOptions } from "../src/extension.ts";
import { registerSubmitTools } from "../src/generated/child-extension.ts";

/**
 * Parent-session package entrypoint.
 *
 * Submit tools are registered only after operator activation, so unrelated Pi
 * sessions remain inert. Child agents explicitly load the generated child-only
 * module with `-e`; they never call this Host entrypoint and therefore cannot
 * recursively start the Core transport or background EventBus.
 */
export default function autopilot(pi: ExtensionAPI, options: AutopilotExtensionOptions = {}): void {
  let registered = false;
  autopilotExtension(pi, {
    ...options,
    onActivated: async () => {
      await options.onActivated?.();
      if (registered) return;
      registered = true;
      registerSubmitTools(pi);
    },
  });
}
