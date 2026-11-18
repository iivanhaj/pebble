// The command table: every command's name -> how many arguments it takes and
// the function that runs it. Each file in this folder holds one group.
import type { Reply } from "../resp/encoder.js";
import { type Command, WrongTypeError, wrongArgs } from "./shared.js";
import { serverCommands } from "./server.js";
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

export function runCommand(words: string[]): Reply {
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
