import type { Reply } from "./resp/encoder.js";
import { store } from "./store.js";

// arity follows Redis's convention: it counts the command name itself, and a
// negative number means "at least". GET is 2 (GET key); DEL is -2 (DEL key [key ...]).
type Command = { arity: number; run: (args: string[]) => Reply };

const commands: Record<string, Command> = {
  PING: {
    arity: -1,
    run: (args) => {
      if (args.length > 1) return wrongArgs("ping");
      return args.length === 0 ? { simple: "PONG" } : args[0];
    },
  },
  ECHO: { arity: 2, run: ([message]) => message },
  GET: { arity: 2, run: ([key]) => store.get(key) ?? null },
  SET: {
    arity: 3, // EX/PX/NX/XX options come with expiry in milestone 3
    run: ([key, value]) => {
      store.set(key, value);
      return { simple: "OK" };
    },
  },
  DEL: { arity: -2, run: (keys) => keys.filter((key) => store.delete(key)).length },
  EXISTS: { arity: -2, run: (keys) => keys.filter((key) => store.has(key)).length },
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
  return command.run(args);
}

function wrongArgs(name: string): Reply {
  return { error: `ERR wrong number of arguments for '${name}' command` };
}
