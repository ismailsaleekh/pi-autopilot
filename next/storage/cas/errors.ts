import type {
  CasError,
  CasErrorCode,
  CasErrorDisposition,
} from "./types.js";

export function casError(
  code: CasErrorCode,
  disposition: CasErrorDisposition,
  operation: string,
  message: string,
  path: string | null = null,
  systemCode: string | null = null,
): CasError {
  return Object.freeze({ code, disposition, message, operation, path, systemCode });
}

export function casSystemCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function casMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "filesystem operation failed";
}

export function casIoError(
  operation: string,
  path: string | null,
  error: unknown,
): CasError {
  const code = casSystemCode(error);
  if (code === "ESTALE") {
    return casError(
      "source-changed",
      "resume",
      operation,
      `filesystem source changed during ${operation}; retry from a quiescent tree`,
      path,
      code,
    );
  }
  if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG") {
    return casError(
      "io-full",
      "resume",
      operation,
      `CAS storage is full during ${operation}; free space and retry the content-addressed operation`,
      path,
      code,
    );
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return casError(
      "io-denied",
      "resume",
      operation,
      `filesystem permission denied during ${operation}: ${casMessage(error)}`,
      path,
      code,
    );
  }
  return casError(
    "io-failure",
    "resume",
    operation,
    `${operation} failed: ${casMessage(error)}`,
    path,
    code,
  );
}
