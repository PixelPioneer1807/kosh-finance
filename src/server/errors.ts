/** Errors whose message is safe to show to the user. Anything else is logged and replaced
 *  with a generic message so internals (SQL, stack traces) never reach the client. */
export type AppErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export class AppError extends Error {
  constructor(
    public code: AppErrorCode,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Item") => new AppError("NOT_FOUND", `${what} not found`);
export const invalid = (message: string, fieldErrors?: Record<string, string[]>) =>
  new AppError("VALIDATION", message, fieldErrors);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export const HTTP_STATUS: Record<AppErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};
