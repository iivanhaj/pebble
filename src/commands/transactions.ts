// MULTI and DISCARD. EXEC lives in commands/index.ts, because it runs other
// commands through runCommand.
import { type Command, OK } from "./shared.js";

export const transactionCommands: Record<string, Command> = {
  // MULTI -> OK. From now on this client's commands are queued, not run,
  // until EXEC runs them all at once or DISCARD drops them.
  MULTI: {
    arity: 1,
    run: (_args, client) => {
      if (client.transaction) return { error: "ERR MULTI calls can not be nested" };
      client.transaction = { queue: [], failed: false };
      return OK;
    },
  },

  // DISCARD -> OK, and the queued commands are thrown away.
  DISCARD: {
    arity: 1,
    run: (_args, client) => {
      if (!client.transaction) return { error: "ERR DISCARD without MULTI" };
      client.transaction = null;
      return OK;
    },
  },
};
