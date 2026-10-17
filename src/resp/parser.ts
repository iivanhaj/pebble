// Reads ONE command from the start of `buf`.
//   - Whole command there -> { words, used }  (used = how many bytes it took)
//   - Not all there yet   -> null             (wait for more data)
//   - Bytes that aren't valid RESP -> throws ProtocolError
// Words are decoded with "latin1": one character per byte (see docs/ARCHITECTURE.md).
//
// Clients always send a command as an array of bulk strings:
//   *3\r\n $3\r\nSET\r\n $4\r\nname\r\n $7\r\nJahnavi\r\n
export type ParseResult = { words: string[]; used: number };

export class ProtocolError extends Error {}

export function parse(buf: Buffer): ParseResult | null {
  let pos = 0; // how far into buf we've read

  // Reads the line starting at pos, without its \r\n, and moves pos past it.
  // Returns null if the \r\n hasn't arrived yet.
  function readLine(): string | null {
    const end = buf.indexOf("\r\n", pos);
    if (end === -1) return null;
    const line = buf.toString("latin1", pos, end);
    pos = end + 2;
    return line;
  }

  const header = readLine(); // e.g. "*3"
  if (header === null) return null;
  const count = readNumber(header, "*");

  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    const lengthLine = readLine(); // e.g. "$7"
    if (lengthLine === null) return null;
    const length = readNumber(lengthLine, "$");

    // Trust the length, not \r\n: the word itself may contain \r\n.
    if (buf.length < pos + length + 2) return null;
    words.push(buf.toString("latin1", pos, pos + length));
    pos += length;

    if (buf[pos] !== 0x0d || buf[pos + 1] !== 0x0a) {
      throw new ProtocolError("Protocol error: expected \r\n after bulk string");
    }
    pos += 2;
  }

  return { words, used: pos };
}

// "*3" with prefix "*" -> 3. Throws if the prefix or the number is wrong.
function readNumber(line: string, prefix: string): number {
  const digits = line.slice(1);
  if (line[0] !== prefix || !/^\d+$/.test(digits)) {
    throw new ProtocolError(`Protocol error: expected '${prefix}<number>', got '${line}'`);
  }
  return Number(digits);
}
