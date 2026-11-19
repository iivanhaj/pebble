// The command table: every command's name -> how many arguments it takes and
// the function that runs it. Each file in this folder holds one group.
import type { Reply } from "../resp/encoder.js";
import * as store from "../store.js";
import { type Command, WrongTypeError, wrongArgs } from "./shared.js";
import { serverCommands } from "./server.js";
export { onSave } from "./server.js";
import { keyCommands } from "./keys.js";
import { stringCommands } from "./strings.js";
import { listCommands } from "./lists.js";
import { hashCommands } from "./hashes.js";
import { setCommands } from "./sets.js";

const commands: Record<string, Command> = {
  ...serverCommands,
  ...keyCommands,
  ...stringCommands,
  ...listCommands,
  ...hashCommands,
  ...setCommands,
};

// Called with the commands to record every time a write command changes data.
// The AOF listens here; commands don't need to know the AOF exists.
type WriteListener = (commands: string[][]) => void;
let writeListener: WriteListener | null = null;

export function onWrite(listener: WriteListener | null): void {
  writeListener = listener;
}

export function runCommand(words: string[]): Reply {
  const upper = words[0].toUpperCase();
  const command = Object.hasOwn(commands, upper) ? commands[upper] : undefined;
  let reply: Reply;
  try {
    reply = execute(words);
  } finally {
    store.settle(); // update the memory estimate for the keys this command touched
  }

  const failed = reply !== null && typeof reply === "object" && "error" in reply;
  if (writeListener && command?.write && !failed) {
    const toRecord = command.toAof ? command.toAof(words.slice(1), reply) : [words];
    if (toRecord.length > 0) writeListener(toRecord);
  }
  return reply;
}

function execute(words: string[]): Reply {
  const [name, ...args] = words;
  const upper = name.toUpperCase();
  if (!Object.hasOwn(commands, upper)) {
    const preview = args.map((arg) => `'${arg}'`).join(" ");
    return { error: `ERR unknown command '${name}', with args beginning with: ${preview}` };
  }
  const command = commands[upper];
  const ok = command.arity > 0 ? words.length === command.arity : words.length >= -command.arity;
  if (!ok) return wrongArgs(name.toLowerCase());

  try {
    return command.run(args);
  } catch (err) {
    if (err instanceof WrongTypeError) {
      return { error: "WRONGTYPE Operation against a key holding the wrong kind of value" };
    }
    throw err;
  }
}
