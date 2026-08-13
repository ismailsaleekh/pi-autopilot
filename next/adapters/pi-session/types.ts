import type {
  ChildObservation,
  LaunchChildSession,
} from "../../ports/contracts/child.capsule.js";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiSubscriptionRoute {
  readonly channel: "subscription";
  readonly model: string;
  readonly provider: string;
  readonly thinking: PiThinkingLevel;
}

export interface PiCliCommand {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

export interface PiSessionLaunchBinding {
  readonly captureDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly extensionPaths: readonly string[];
  readonly maxStderrBytes: number;
  readonly maxStdoutBytes: number;
  readonly piCommand: PiCliCommand;
  readonly promptArtifactPath: string;
  readonly promptArtifactRoot: string;
  readonly promptFilePath: string;
  readonly route: PiSubscriptionRoute;
  readonly runtimeRoot: string;
  readonly sessionDirectory: string;
  readonly toolNames: readonly string[];
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceRoot: string;
}

export interface PiSessionBindingResolver {
  readonly observeSealedRoot: (child: PiSessionChildReference) => Promise<unknown>;
  readonly resolveLaunch: (intent: LaunchChildSession) => Promise<unknown>;
}

export interface PiSessionChildReference {
  readonly childEpoch: string;
  readonly childId: string;
  readonly runId: string;
  readonly sessionDirectory: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
}

export interface PiProcessCaptureObservation {
  readonly capturedBytes: string;
  readonly faultCode: string | null;
  readonly observedBytes: string;
  readonly path: string;
  readonly truncated: boolean;
}

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
  | {
      readonly kind: "collected";
      readonly observation: Readonly<{
        readonly bytes: Uint8Array;
        readonly truncated: boolean;
      }>;
    }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };

export type PiProcessTerminationResult =
  | {
      readonly kind: "terminated";
      readonly observation: Readonly<{
        readonly after: PiProcessObservation;
        readonly escalated: boolean;
      }>;
    }
  | { readonly diagnostic: Readonly<{ readonly code: string; readonly message: string }>; readonly kind: "rejected" };

export interface PiProcessExecutor<Handle> {
  readonly collectOutput: (handle: Handle, request: unknown) => Promise<PiProcessOutputReadResult>;
  readonly observe: (handle: Handle) => PiProcessObserveResult;
  readonly start: (request: unknown) => Promise<PiProcessStartResult<Handle>>;
  readonly terminate: (
    handle: Handle,
    options: Readonly<{ readonly graceMilliseconds: number }>,
  ) => Promise<PiProcessTerminationResult>;
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
  | {
      readonly authType: "oauth";
      readonly kind: "verified";
      readonly model: string;
      readonly provider: string;
    }
  | {
      readonly code: string;
      readonly kind: "refused";
      readonly model: string;
      readonly provider: string;
    };

export type PiProbeDeadlineResult<Value> =
  | { readonly kind: "completed"; readonly value: Value }
  | { readonly kind: "time-bound" };

/**
 * One cancellable physical deadline supplied by the runtime clock owner. The
 * Pi adapter owns no timer or scheduling primitive.
 */
export interface PiProbeDeadline {
  readonly race: <Value>(
    operation: Promise<Value>,
    timeoutMilliseconds: number,
  ) => Promise<PiProbeDeadlineResult<Value>>;
}

export interface PiRouteVerifier {
  readonly verify: (request: PiRouteVerificationRequest) => Promise<PiRouteGuardObservation>;
}

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

export interface PiSessionDiagnostic {
  readonly code: string;
  readonly message: string;
}

export type PiSessionExecution =
  | {
      readonly kind: "observation";
      readonly observation: ChildObservation;
      readonly physical: PiSessionPhysicalObservation;
    }
  | { readonly diagnostic: PiSessionDiagnostic; readonly kind: "rejected" };
