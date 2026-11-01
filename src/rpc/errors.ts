export class RpcResponseError extends Error {
  override readonly name = "RpcResponseError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class RequestTimeoutError extends Error {
  override readonly name = "RequestTimeoutError";
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`request "${method}" timed out after ${timeoutMs} ms`);
  }
}

export class WriteQueueFullError extends Error {
  override readonly name = "WriteQueueFullError";
  constructor(readonly limitBytes: number) {
    super(`stdin write queue exceeds ${limitBytes} bytes`);
  }
}

export class ProcessExitError extends Error {
  override readonly name = "ProcessExitError";
  constructor(
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly lastStderrLine: string | null,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`${reason}${lastStderrLine ? `: ${lastStderrLine}` : ""}`, options);
  }
}
