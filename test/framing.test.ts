import { expect, test } from "bun:test";
import { ByteLineFramer, LineTooLongError } from "../src/rpc/framing";

test("line budget counts bytes across chunks, and accepts exactly the limit", () => {
  const framer = new ByteLineFramer(4);
  const lines: string[] = [];
  framer.push(Buffer.from("123"), (line) => { lines.push(line.toString()); });
  framer.push(Buffer.from("4\nnext\n"), (line) => { lines.push(line.toString()); });
  expect(lines).toEqual(["1234", "next"]);
  framer.push(Buffer.from("1234"), () => {});
  expect(() => framer.push(Buffer.from("5"), () => {})).toThrow(LineTooLongError);
});

test("blank and CRLF lines remain individual byte frames", () => {
  const framer = new ByteLineFramer(100);
  const lines: string[] = [];
  framer.push(Buffer.from("\nhello\r\n"), (line) => { lines.push(line.toString()); });
  expect(lines).toEqual(["", "hello\r"]);
  expect(framer.hasPartialLine).toBe(false);
});
