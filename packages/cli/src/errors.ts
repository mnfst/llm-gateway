/**
 * The one failure type the CLI raises. Serialized to the stable error JSON
 * contract on stdout: { error, message, hint?, status? } with exit code 1.
 */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CliError';
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
  }
}
