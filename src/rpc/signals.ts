import type { RpcConnection } from "./connection";

/** Opt in at the application boundary; the transport never takes global signals. */
export function installRpcSignalHandlers(connections: Iterable<RpcConnection>): {
  readonly exitCode: number | undefined;
  dispose(): void;
} {
  let exitCode: number | undefined;
  let stopping: Promise<PromiseSettledResult<void>[]> | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    exitCode ??= signal === "SIGINT" ? 130 : 143;
    // Keep listeners installed during shutdown so a second signal cannot bypass it.
    stopping ??= Promise.allSettled(Array.from(connections, (connection) => connection.stop()));
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return {
    get exitCode() { return exitCode; },
    dispose() {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    },
  };
}
