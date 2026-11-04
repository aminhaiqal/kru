#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { chat } from "./chat";
import { mailboxCommand } from "./mailbox";
import packageJson from "../../package.json";
import { RpcConnection, installRpcSignalHandlers } from "../rpc";

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (["init", "agent", "send", "queue", "cancel", "retry"].includes(args[0] ?? "")) {
    try { return mailboxCommand(args); }
    catch (error) { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  }
  if (args[0] === "chat") {
    try { return await chat(args.slice(1)); }
    catch (error) { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    console.log(packageJson.version);
    return 0;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: kru rpc ping --fake [--stall] [--timeout-ms <milliseconds>]\n       kru chat [--provider fake|codex|claude] [prompt]\n       kru init\n       kru agent create <name> --provider fake|codex|claude\n       kru agent list\n       kru send <agent> <text>\n       kru queue <agent>\n       kru cancel <delivery>\n       kru retry <delivery>\n       kru --version");
    return 0;
  }
  if (args[0] !== "rpc" || args[1] !== "ping" || !args.includes("--fake")) {
    console.error("error: expected kru rpc ping --fake (see --help)");
    return 1;
  }
  let timeoutMs = 2_000;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--fake" || arg === "--stall") continue;
    if (arg === "--timeout-ms") {
      timeoutMs = Number(args[++i]);
      if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) continue;
    }
    console.error(`error: invalid argument ${arg}`);
    return 1;
  }
  const connection = new RpcConnection({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../test/fakes/fake-agent.ts", import.meta.url)), ...(args.includes("--stall") ? ["--stall"] : [])],
    requestTimeoutMs: timeoutMs,
    maxLineBytes: 256 * 1024 * 1024,
    maxQueuedWriteBytes: 4 * 1024 * 1024,
    maxBadLines: 3,
  });
  const shutdown = installRpcSignalHandlers([connection]);
  try {
    connection.start();
    const started = performance.now();
    const result = await connection.request("ping", {}, {
      decode: (value) => {
        if (value !== "pong") throw new Error("expected pong from fake agent");
        return value;
      },
    });
    console.log(`${result} (${(performance.now() - started).toFixed(1)} ms)`);
    return shutdown.exitCode ?? 0;
  } catch (error) {
    if (shutdown.exitCode !== undefined) return shutdown.exitCode;
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await connection.stop();
    shutdown.dispose();
  }
}

if (import.meta.main) process.exitCode = await main();
