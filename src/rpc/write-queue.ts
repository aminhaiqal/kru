import type { Writable } from "node:stream";
import { WriteQueueFullError } from "./errors";

interface Write {
  data: Buffer;
  resolve: () => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

/** Includes the active write in the budget; never feeds a blocked stdin. */
export class WriteQueue {
  private queue: Write[] = [];
  private active: Write | undefined;
  private failure: Error | undefined;
  private bytes = 0;

  constructor(
    private readonly stream: Writable,
    private readonly limit: number,
    private readonly onBlocked: (bytes: number) => void,
    private readonly onFailure: (error: Error) => void,
  ) {}

  get queuedBytes(): number {
    return this.bytes;
  }

  send(data: Buffer, signal?: AbortSignal): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.bytes + data.length > this.limit) return Promise.reject(new WriteQueueFullError(this.limit));
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(write);
        if (index !== -1) {
          this.queue.splice(index, 1);
          this.bytes -= data.length;
        }
        write.cleanup();
        reject(signal?.reason);
      };
      const write: Write = {
        data, resolve, reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.bytes += data.length;
      this.queue.push(write);
      this.pump();
    });
  }

  close(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.stream.removeListener("drain", this.onDrain);
    for (const write of [this.active, ...this.queue]) {
      if (!write) continue;
      write.cleanup();
      write.reject(error);
    }
    this.active = undefined;
    this.queue = [];
    this.bytes = 0;
  }

  private blocked = false;
  private onDrain = (): void => {
    this.blocked = false;
    this.pump();
  };

  private pump(): void {
    if (this.failure || this.active || this.blocked) return;
    const write = this.queue.shift();
    if (!write) return;
    this.active = write;
    try {
      const ready = this.stream.write(write.data, (error?: Error | null) => {
        if (this.failure) return;
        this.bytes -= write.data.length;
        this.active = undefined;
        write.cleanup();
        if (error) {
          this.onFailure(error);
          write.reject(error);
          this.close(error);
        } else {
          write.resolve();
          this.pump();
        }
      });
      if (!ready) {
        this.blocked = true;
        this.stream.once("drain", this.onDrain);
        this.onBlocked(this.bytes);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.onFailure(failure);
      this.close(failure);
    }
  }
}
