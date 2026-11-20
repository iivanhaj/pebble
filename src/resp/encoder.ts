// Turns a command's reply into RESP2 bytes to send back to the client.
//
// How each JS value is sent:
//   "Jahnavi"           bulk string   $7\r\nJahnavi\r\n
//   null                null bulk     $-1\r\n          (e.g. GET on a missing key)
//   3 or 3n             integer       :3\r\n           (BigInt for 64-bit values)
//   ["a", "b"]          array         *2\r\n$1\r\na\r\n$1\r\nb\r\n
//   { simple: "OK" }    simple string +OK\r\n
//   { error: "ERR x" }  error         -ERR x\r\n
//   { nullArray: true } null array  *-1\r\n           (EXEC when a WATCHed key changed)
//   { sequence: [a, b] } a then b, as two separate replies to one command
//                        (SUBSCRIBE a b confirms each channel separately)
export type Reply =
  | string
  | number
  | bigint
  | null
  | Reply[]
  | { simple: string }
  | { sequence: Reply[] }
  | { nullArray: true }
  | { error: string };

export function encode(reply: Reply): Buffer {
  return Buffer.from(toResp(reply), "latin1");
}

function toResp(reply: Reply): string {
  if (reply === null) return "$-1\r\n";
  if (typeof reply === "string") return `$${reply.length}\r\n${reply}\r\n`;
  if (typeof reply === "number" || typeof reply === "bigint") return `:${reply}\r\n`;
  if (Array.isArray(reply)) return `*${reply.length}\r\n${reply.map(toResp).join("")}`;
  if ("simple" in reply) return `+${reply.simple}\r\n`;
  if ("sequence" in reply) return reply.sequence.map(toResp).join("");
  if ("nullArray" in reply) return "*-1\r\n";
  return `-${reply.error}\r\n`;
}
