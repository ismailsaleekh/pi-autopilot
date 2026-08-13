export const CRASH_POINT_IDS = Object.freeze([
  "filesystem.append",
  "filesystem.file-fsync",
  "filesystem.rename",
  "filesystem.directory-fsync",
  "store.install.append",
  "store.install.file-fsync",
  "store.install.rename",
  "store.install.directory-fsync",
  "store.install.ack",
  "store.list.append",
  "store.list.file-fsync",
  "store.list.rename",
  "store.list.directory-fsync",
  "store.list.ack",
  "journal.append",
  "journal.fsync",
  "journal.ack",
  "git.seal.append",
  "git.seal.file-fsync",
  "git.seal.rename",
  "git.seal.directory-fsync",
  "git.seal.ack",
  "git.integrate.append",
  "git.integrate.file-fsync",
  "git.integrate.rename",
  "git.integrate.directory-fsync",
  "git.integrate.ack",
  "git.publish.before-read",
  "git.publish.after-read",
  "git.publish.before-cas",
  "git.publish.after-cas",
  "git.publish.ack",
  "child.seal.append",
  "child.seal.file-fsync",
  "child.seal.rename",
  "child.seal.directory-fsync",
  "child.seal.ack",
] as const);

export type CrashPointId = (typeof CRASH_POINT_IDS)[number];

export interface CrashPoint {
  readonly id: CrashPointId;
  readonly occurrence: number;
}

export interface CrashPointDescription {
  readonly id: CrashPointId;
  readonly layer: "filesystem" | "store" | "journal" | "git" | "child";
  readonly operation: "append" | "fsync" | "rename" | "dirsync" | "ack" | "cas-window";
  readonly durableWhenReached: boolean;
}

function layerOf(id: CrashPointId): CrashPointDescription["layer"] {
  if (id.startsWith("filesystem.")) {
    return "filesystem";
  }
  if (id.startsWith("store.")) {
    return "store";
  }
  if (id.startsWith("journal.")) {
    return "journal";
  }
  if (id.startsWith("git.")) {
    return "git";
  }
  return "child";
}

function operationOf(id: CrashPointId): CrashPointDescription["operation"] {
  if (id.endsWith("directory-fsync")) {
    return "dirsync";
  }
  if (id.endsWith("file-fsync") || id.endsWith(".fsync")) {
    return "fsync";
  }
  if (id.endsWith(".append")) {
    return "append";
  }
  if (id.endsWith(".rename")) {
    return "rename";
  }
  if (id.endsWith(".ack")) {
    return "ack";
  }
  return "cas-window";
}

function durableAt(id: CrashPointId): boolean {
  return id.endsWith("file-fsync")
    || id.endsWith("directory-fsync")
    || id === "journal.fsync"
    || id === "git.publish.after-cas"
    || id.endsWith(".ack");
}

export const CRASH_POINT_REGISTRY: readonly CrashPointDescription[] = Object.freeze(
  CRASH_POINT_IDS.map((id) => Object.freeze({
    id,
    layer: layerOf(id),
    operation: operationOf(id),
    durableWhenReached: durableAt(id),
  })),
);

export function isCrashPointId(input: unknown): input is CrashPointId {
  return typeof input === "string" && CRASH_POINT_IDS.some((id) => id === input);
}

export function decodeCrashPoint(input: unknown): CrashPoint | null {
  try {
    if (isCrashPointId(input)) {
      return Object.freeze({ id: input, occurrence: 1 });
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const id = Reflect.get(input, "id");
    const occurrence = Reflect.get(input, "occurrence");
    if (
      !isCrashPointId(id)
      || !Number.isSafeInteger(occurrence)
      || typeof occurrence !== "number"
      || occurrence < 1
    ) {
      return null;
    }
    return Object.freeze({ id, occurrence });
  } catch {
    return null;
  }
}
