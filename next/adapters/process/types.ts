import type { Writable } from "node:stream";

export type ProcessSignal = "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGKILL";

export interface PhysicalDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface ProcessCaptureTarget {
  readonly path: string;
  readonly stream: Writable;
}

export type ProcessCaptureAcquireResult =
  | {
      readonly kind: "acquired";
      readonly stderr: ProcessCaptureTarget;
      readonly stdout: ProcessCaptureTarget;
    }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };

/**
 * Capability supplied by a durable-write-approved owner (storage or workspace).
 * Process mechanics never open a path for write themselves.
 */
export interface ProcessCaptureSink {
  readonly acquire: (request: Readonly<{
    readonly captureDirectory: string;
    readonly captureId: string;
  }>) => Promise<ProcessCaptureAcquireResult>;
}

/** One physical grace delay supplied by the runtime clock owner. */
export interface ProcessGraceWaiter {
  readonly waitForGrace: (milliseconds: number) => Promise<void>;
}

export interface ProcessStartRequest {
  readonly arguments: readonly string[];
  readonly captureDirectory: string;
  readonly captureId: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly maxStderrBytes: number;
  readonly maxStdoutBytes: number;
}

/** Durable, restart-safe physical identity. The birth marker fences PID reuse. */
export interface ProcessDescriptor {
  readonly captureId: string;
  readonly environmentKeys: readonly string[];
  readonly groupId: number;
  readonly pid: number;
  readonly processBirthMarker: string;
  readonly stderrPath: string;
  readonly stdoutPath: string;
}

export interface ProcessDescriptorRequest {
  readonly captureId: string;
  readonly environmentKeys: readonly string[];
  readonly groupId: number;
  readonly pid: number;
  readonly stderrPath: string;
  readonly stdoutPath: string;
}

/** Host identity probe; implemented outside process mechanics for deterministic tests. */
export interface ProcessIdentityInspector {
  readonly birthMarker: (pid: number) => string | null;
}

export interface CaptureObservation {
  readonly capturedBytes: string;
  readonly faultCode: string | null;
  readonly observedBytes: string;
  readonly path: string;
  readonly truncated: boolean;
}

export type ProcessLifecycleObservation =
  | { readonly kind: "running" }
  | { readonly code: number; readonly kind: "exited" }
  | { readonly kind: "signalled"; readonly signal: string }
  | { readonly kind: "unavailable" };

export type ProcessGroupObservation =
  | { readonly kind: "alive"; readonly processGroupId: number }
  | { readonly kind: "absent"; readonly processGroupId: number }
  | { readonly code: string; readonly kind: "unobservable"; readonly processGroupId: number };

export interface ProcessObservation {
  readonly environmentKeys: readonly string[];
  readonly lifecycle: ProcessLifecycleObservation;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly processGroup: ProcessGroupObservation;
  readonly stderr: CaptureObservation;
  readonly stdout: CaptureObservation;
}

export type ProcessStartResult<Handle> =
  | {
      readonly handle: Handle;
      readonly kind: "started";
      readonly observation: ProcessObservation;
    }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };

export type ProcessObserveResult =
  | { readonly kind: "observed"; readonly observation: ProcessObservation }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };

export type ProcessDescriptorResult =
  | { readonly descriptor: ProcessDescriptor; readonly kind: "described" }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };

export type ProcessColdObservation =
  | { readonly groupId: number; readonly kind: "absent"; readonly pid: number }
  | { readonly groupId: number; readonly kind: "running"; readonly pid: number }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };

export type ProcessColdTerminationResult =
  | { readonly escalated: boolean; readonly groupId: number; readonly kind: "terminated"; readonly pid: number; readonly state: "fenced" | "already-absent" }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };

export interface SignalDeliveryObservation {
  readonly after: ProcessObservation;
  readonly before: ProcessObservation;
  readonly requestedSignal: ProcessSignal;
  readonly state: "delivered" | "already-absent" | "not-delivered";
}

export type ProcessSignalResult =
  | { readonly kind: "signalled"; readonly observation: SignalDeliveryObservation }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };

export interface ProcessTerminationObservation {
  readonly after: ProcessObservation;
  readonly before: ProcessObservation;
  readonly escalated: boolean;
  readonly graceMilliseconds: number;
  readonly gracefulSignal: SignalDeliveryObservation;
  readonly killSignal: SignalDeliveryObservation | null;
}

export type ProcessTerminationResult =
  | { readonly kind: "terminated"; readonly observation: ProcessTerminationObservation }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };

export interface ProcessOutputReadRequest {
  readonly direction: "head" | "tail";
  readonly maxBytes: number;
  readonly stream: "stderr" | "stdout";
}

export interface ProcessOutputObservation {
  readonly bytes: Uint8Array;
  readonly direction: "head" | "tail";
  readonly fileBytes: string;
  readonly path: string;
  readonly sourceTruncated: boolean;
  readonly stream: "stderr" | "stdout";
  readonly truncated: boolean;
}

export type ProcessOutputReadResult =
  | { readonly kind: "collected"; readonly observation: ProcessOutputObservation }
  | { readonly diagnostic: PhysicalDiagnostic; readonly kind: "rejected" };
