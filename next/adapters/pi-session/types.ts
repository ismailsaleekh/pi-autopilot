import type { ArtifactRef } from "../../authority/protocol/identifiers.js";
import type { SubscriptionRoute } from "../../authority/protocol/route.capsule.js";
import type { ChildObservation, ChildIntent, LaunchChildSession, VerifyPiRoute } from "../../ports/contracts/child.capsule.js";

export type PiThinkingLevel = SubscriptionRoute["thinking"];
export type PiSubscriptionRoute = SubscriptionRoute;
export interface PiCliCommand { readonly executable: string; readonly prefixArguments: readonly string[] }

/** Resolver supplies physical locations only; intent owns every semantic choice. */
export interface PiSessionLaunchBinding {
  readonly captureDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly piCommand: PiCliCommand;
  readonly promptFilePath: string;
  readonly sessionDirectory: string;
  readonly workspacePath: string;
}
export interface PiSessionBindingResolver {
  readonly resolveLaunch: (intent: LaunchChildSession | VerifyPiRoute) => Promise<unknown>;
  readonly persistProcessDescriptor: (descriptor: PiDurableChildDescriptor) => Promise<ArtifactRef>;
  readonly loadProcessDescriptor: (reference: ArtifactRef) => Promise<unknown>;
}

export interface PiDurableProcessDescriptor {
  readonly captureId: string;
  readonly environmentKeys: readonly string[];
  readonly groupId: number;
  readonly pid: number;
  readonly processBirthMarker: string;
  readonly stderrPath: string;
  readonly stdoutPath: string;
}

export interface PiDurableChildDescriptor {
  readonly childEpoch: string;
  readonly childId: string;
  readonly process: PiDurableProcessDescriptor;
  readonly runId: string;
  readonly sessionDirectory: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

export type PiProcessDescriptorResult =
  | { readonly descriptor: PiDurableProcessDescriptor; readonly kind: "described" }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };
export type PiColdProcessObservation =
  | { readonly groupId: number; readonly kind: "absent"; readonly pid: number }
  | { readonly groupId: number; readonly kind: "running"; readonly pid: number }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };
export type PiColdProcessTerminationResult =
  | { readonly escalated: boolean; readonly groupId: number; readonly kind: "terminated"; readonly pid: number; readonly state: "fenced" | "already-absent" }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };
export interface PiSessionChildReference {
  readonly childEpoch: string;
  readonly childId: string;
  readonly runId: string;
  readonly sessionDirectory: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
}

export interface PiProcessCaptureObservation { readonly capturedBytes: string; readonly faultCode: string | null; readonly observedBytes: string; readonly path: string; readonly truncated: boolean }
export type PiProcessLifecycleObservation =
  | { readonly kind: "running" }
  | { readonly code: number; readonly kind: "exited" }
  | { readonly kind: "signalled"; readonly signal: string }
  | { readonly kind: "unavailable" };
export interface PiProcessObservation {
  readonly environmentKeys: readonly string[];
  readonly lifecycle: PiProcessLifecycleObservation;
  readonly pid: number;
  readonly processGroup: Readonly<{ readonly kind: string; readonly processGroupId: number }>;
  readonly stderr: PiProcessCaptureObservation;
  readonly stdout: PiProcessCaptureObservation;
}
export type PiProcessStartResult<Handle> =
  | { readonly handle: Handle; readonly kind: "started"; readonly observation: PiProcessObservation }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };
export type PiProcessObserveResult =
  | { readonly kind: "observed"; readonly observation: PiProcessObservation }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };
export type PiProcessOutputReadResult =
  | { readonly kind: "collected"; readonly observation: Readonly<{ readonly bytes: Uint8Array; readonly truncated: boolean }> }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };
export type PiProcessTerminationResult =
  | { readonly kind: "terminated"; readonly observation: Readonly<{ readonly after: PiProcessObservation; readonly escalated: boolean }> }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };
export interface PiProcessExecutor<Handle> {
  readonly collectOutput: (handle: Handle, request: unknown) => Promise<PiProcessOutputReadResult>;
  readonly describe: (handle: Handle) => PiProcessDescriptorResult;
  readonly observe: (handle: Handle) => PiProcessObserveResult;
  readonly observeDescriptor: (descriptor: PiDurableProcessDescriptor) => PiColdProcessObservation;
  readonly start: (request: unknown) => Promise<PiProcessStartResult<Handle>>;
  readonly terminate: (handle: Handle, options: Readonly<{ readonly graceMilliseconds: number }>) => Promise<PiProcessTerminationResult>;
  readonly terminateDescriptor: (descriptor: PiDurableProcessDescriptor, options: Readonly<{ readonly graceMilliseconds: number }>) => Promise<PiColdProcessTerminationResult>;
  readonly waitForExit: (handle: Handle) => Promise<PiProcessObserveResult>;
}

export interface PiRouteVerificationRequest {
  readonly captureDirectory: string;
  readonly captureId: string;
  readonly command: PiCliCommand;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly route: PiSubscriptionRoute;
}
export type PiRouteGuardObservation =
  | { readonly authType: "oauth"; readonly kind: "verified"; readonly model: string; readonly provider: string }
  | { readonly code: string; readonly kind: "refused"; readonly model: string; readonly provider: string };
export type PiProbeDeadlineResult<Value> = { readonly kind: "completed"; readonly value: Value } | { readonly kind: "time-bound" };
export interface PiProbeDeadline { readonly race: <Value>(operation: Promise<Value>, timeoutMilliseconds: number) => Promise<PiProbeDeadlineResult<Value>> }
export interface PiRouteVerifier { readonly verify: (request: PiRouteVerificationRequest) => Promise<PiRouteGuardObservation> }

export interface PiSessionPhysicalObservation {
  readonly childEpoch: string;
  readonly childId: string;
  readonly process: PiProcessObservation | null;
  readonly route: PiRouteGuardObservation | { readonly kind: "not-checked" };
  readonly sessionDirectory: string | null;
  readonly sessionFile: string | null;
  readonly sessionFiles: readonly string[];
  readonly sessionId: string | null;
  readonly sessionScanCode: string | null;
  readonly sealedRoot: string | null;
  readonly termination: Readonly<{ readonly escalated: boolean }> | null;
}
export interface PiSessionDiagnostic { readonly code: string; readonly message: string }
export type PiSessionExecution =
  | { readonly kind: "observation"; readonly observation: ChildObservation; readonly physical: PiSessionPhysicalObservation }
  | { readonly diagnostic: PiSessionDiagnostic; readonly kind: "rejected" };

export type { ChildIntent };
