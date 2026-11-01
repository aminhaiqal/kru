import type { RpcConnection } from "./connection";

/** Opt in at the application boundary; the transport never takes global signals. */
export function installRpcSignalHandlers(connections: Iterable<RpcConnection>): {
  readonly exitCode: number | undefined;
  dispose(): void;
} {
  let exitCode: number | undefined;
  let stopping: Promise<PromiseSettledResult<void>[]> | undefined;
  let forcing: Promise<PromiseSettledResult<void>[]> | undefined;
  const tracked = new Set(connections);
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    exitCode ??= signal === "SIGINT" ? 130 : 143;
    for (const connection of connections) tracked.add(connection);
    if (!stopping) stopping = Promise.allSettled(Array.from(tracked, (connection) => connection.stop()));
    // Do not await one group before signalling the next. forceStop sends SIGKILL
    // synchronously, interrupts its grace period, and then waits only for reaping.
    else if (!forcing) {
      forcing = Promise.allSettled(Array.from(tracked, (connection) => connection.forceStop()));
      void forcing.then(() => process.exit(exitCode ?? 130));
    }
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
