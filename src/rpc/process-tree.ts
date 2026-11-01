import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function signalGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    // macOS can report EPERM for an exited group until the child is reaped.
    // Yield once; persistent permission failures still preserve its ownership record.
    await delay(10);
    try { process.kill(-pid, signal); }
    catch (retryError) { if ((retryError as NodeJS.ErrnoException).code !== "ESRCH") throw retryError; }
  }
}

/** Children inherit a dedicated process group, including their stdio helpers. */
export async function terminateTree(child: ChildProcess, graceMs: number, forceSignal: AbortSignal): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", reject);
      killer.once("exit", () => resolve());
    });
    return;
  }
  const pid = child.pid;
  let forceResult: Promise<void> | undefined;
  const force = () => {
    // signalGroup sends synchronously before its first await, so all registered
    // groups receive SIGKILL in the signal handler's turn, without serial waits.
    forceResult ??= signalGroup(pid, "SIGKILL");
    // Observe a rejection immediately; the shutdown path rethrows it below.
    void forceResult.catch(() => {});
  };
  forceSignal.addEventListener("abort", force, { once: true });
  try {
    if (forceSignal.aborted) force();
    else await signalGroup(pid, "SIGTERM");
    const deadline = performance.now() + graceMs;
    while (!forceSignal.aborted && groupExists(pid) && performance.now() < deadline) await delay(10);
    if (forceSignal.aborted) await forceResult;
    // The parent may have exited while a grandchild ignores SIGTERM.
    else if (groupExists(pid)) await signalGroup(pid, "SIGKILL");
  } finally { forceSignal.removeEventListener("abort", force); }
}
