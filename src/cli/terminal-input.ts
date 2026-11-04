import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** One input consumer for both chat messages and approval answers. */
export class TerminalInput {
  private readonly readline: Interface;
  private pending: { finish: (line: string | undefined) => void } | undefined;
  private closed = false;

  constructor(input: Readable, private readonly output: Writable, terminal = true, onInterrupt = () => { process.emit('SIGINT'); }) {
    this.readline = createInterface({ input, output, terminal });
    this.readline.on('SIGINT', onInterrupt);
    this.readline.on('close', () => { this.closed = true; this.pending?.finish(undefined); });
    // Lines entered while the assistant is busy are discarded, never buffered
    // as consent for a request the user has not seen yet.
    this.readline.on('line', line => this.pending?.finish(line));
  }

  write(text: string): void { this.output.write(text); }

  read(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.closed || signal?.aborted) return Promise.resolve(undefined);
    if (this.pending) throw new Error('Terminal input already has a reader');
    // Clear partial input typed before this question was displayed, too.
    // Assign the public buffer directly: Bun's readline.write(null, ctrl-U)
    // currently leaves the old text intact.
    const buffer = this.readline as { line: string; cursor: number };
    buffer.line = '';
    buffer.cursor = 0;
    return new Promise(resolve => {
      const abort = () => {
        this.write('\nApproval cancelled or expired; input closed.\n');
        // A late answer must never grant the next queued request.
        this.close();
      };
      this.pending = { finish: line => {
        this.pending = undefined;
        signal?.removeEventListener('abort', abort);
        resolve(line);
      } };
      signal?.addEventListener('abort', abort, { once: true });
      this.readline.setPrompt(prompt);
      this.readline.prompt();
    });
  }

  close(): void { this.readline.close(); }
}
