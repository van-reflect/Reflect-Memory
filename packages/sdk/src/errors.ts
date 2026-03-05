/**
 * Error thrown when the Reflect Memory API returns a non-2xx response.
 *
 * Includes the HTTP status code, a human-readable message, and the raw
 * response body for debugging.
 */
export class ReflectMemoryError extends Error {
  /** HTTP status code from the API response. */
  readonly status: number;
  /** Raw response body, parsed as JSON when possible. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ReflectMemoryError";
    this.status = status;
    this.body = body;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
