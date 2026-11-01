export class LineTooLongError extends Error {
  constructor(readonly maxLineBytes: number) {
    super(`stdout line exceeds ${maxLineBytes} bytes`);
  }
}

/** Split bytes before decoding: UTF-8 code points may span stream chunks. */
export class ByteLineFramer {
  private parts: Buffer[] = [];
  private length = 0;

  constructor(private readonly maxLineBytes: number) {}

  push(chunk: Buffer, onLine: (line: Buffer) => boolean | void): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end === -1 ? chunk.length : end);
      this.length += part.length;
      if (this.length > this.maxLineBytes) throw new LineTooLongError(this.maxLineBytes);
      this.parts.push(part);
      if (end === -1) return;
      const line = Buffer.concat(this.parts, this.length);
      this.parts = [];
      this.length = 0;
      if (onLine(line) === false) return;
      start = end + 1;
    }
  }

  get hasPartialLine(): boolean {
    return this.length > 0;
  }

  clear(): void {
    this.parts = [];
    this.length = 0;
  }
}
