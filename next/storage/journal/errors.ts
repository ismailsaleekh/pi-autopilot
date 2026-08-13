import type {
  JournalEpoch,
  JournalError,
  JournalErrorCode,
  JournalErrorDisposition,
} from "./types.js";

export function journalError(
  code: JournalErrorCode,
  disposition: JournalErrorDisposition,
  operation: string,
  message: string,
  path: string | null = null,
  epoch: JournalEpoch | null = null,
  systemCode: string | null = null,
): JournalError {
  return Object.freeze({
    code,
    disposition,
    epoch,
    message,
    operation,
    path,
    systemCode,
  });
}

export function errorSystemCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  try {
    const value = Reflect.get(error, "code");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "filesystem operation failed";
}

export function journalIoError(
  operation: string,
  path: string | null,
  error: unknown,
  epoch: JournalEpoch | null = null,
): JournalError {
  const systemCode = errorSystemCode(error);
  if (systemCode === "ENOSPC" || systemCode === "EDQUOT" || systemCode === "EFBIG") {
    return journalError(
      "io-full",
      "resume",
      operation,
      `durable storage is full during ${operation}; free space and resume without discarding the valid prefix`,
      path,
      epoch,
      systemCode,
    );
  }
  if (systemCode === "EACCES" || systemCode === "EPERM" || systemCode === "EROFS") {
    return journalError(
      "io-denied",
      "resume",
      operation,
      `filesystem permission denied during ${operation}: ${errorMessage(error)}`,
      path,
      epoch,
      systemCode,
    );
  }
  return journalError(
    "io-failure",
    "resume",
    operation,
    `${operation} failed: ${errorMessage(error)}`,
    path,
    epoch,
    systemCode,
  );
}
