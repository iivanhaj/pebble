// Turns a command's reply into RESP2 bytes to send back to the client.
//
// How each JS value is sent:
//   "Jahnavi"           bulk string   $7\r\nJahnavi\r\n
//   null                null bulk     $-1\r\n          (e.g. GET on a missing key)
//   3                   integer       :3\r\n
//   ["a", "b"]          array         *2\r\n$1\r\na\r\n$1\r\nb\r\n
//   { simple: "OK" }    simple string +OK\r\n
//   { error: "ERR x" }  error         -ERR x\r\n
export type Reply =
  | string
  | number
  | null
  | Reply[]
  | { simple: string }
  | { error: string };

export function encode(reply: Reply): Buffer {
  return Buffer.from(toResp(reply), "latin1");
}

function toResp(reply: Reply): string {
  if (reply === null) return "$-1\r\n";
  if (typeof reply === "string") return `$${reply.length}\r\n${reply}\r\n`;
  if (typeof reply === "number") return `:${reply}\r\n`;
  if (Array.isArray(reply)) return `*${reply.length}\r\n${reply.map(toResp).join("")}`;
  if ("simple" in reply) return `+${reply.simple}\r\n`;
  return `-${reply.error}\r\n`;
}
