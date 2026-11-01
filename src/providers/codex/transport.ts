import { RpcConnection, type RpcConnectionOptions } from "../../rpc";

export type CodexConnectionOptions = Partial<Omit<RpcConnectionOptions, "jsonrpcField">>;

/** Shared connection factory for the M1 Codex adapter and its real-server smoke test. */
export function createCodexRpcConnection(options: CodexConnectionOptions = {}): RpcConnection {
  return new RpcConnection({
    command: "codex", args: ["app-server", "--listen", "stdio://"],
    requestTimeoutMs: 10_000, maxLineBytes: 256 * 1024 * 1024,
    maxQueuedWriteBytes: 4 * 1024 * 1024, maxBadLines: 3,
    ...options,
    // This is a wire contract, not a permissive-server assumption.
    jsonrpcField: false,
  });
}
