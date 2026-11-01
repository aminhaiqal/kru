import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Children inherit a dedicated process group, including their stdio helpers. */
export async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", reject);
      killer.once("exit", () => resolve());
    });
    return;
  }
  signalGroup(child.pid, "SIGTERM");
  const deadline = performance.now() + 100;
  while (groupExists(child.pid) && performance.now() < deadline) await delay(10);
  // The parent may have exited while a grandchild ignores SIGTERM.
  if (groupExists(child.pid)) signalGroup(child.pid, "SIGKILL");
}
