/** Typed HTTP failure. The global error handler maps it first, so `code`, `details` and `headers` reach the response intact. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly headers?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
  }
}
