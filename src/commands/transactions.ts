// MULTI, DISCARD, WATCH and UNWATCH. EXEC lives in commands/index.ts,
// because it runs other commands through runCommand.
import * as store from "../store.js";
import * as watch from "../watch.js";
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
      watch.unwatchAll(client);
      return OK;
    },
  },

  // WATCH key [key ...] -> OK. If any of these keys changes before this
  // client's next EXEC, that EXEC returns nil instead of running.
  WATCH: {
    arity: -2,
    run: (keys, client) => {
      if (client.transaction) return { error: "ERR WATCH inside MULTI is not allowed" };
      for (const key of keys) {
        store.has(key); // clears the key first if it already expired, so that doesn't count as a change
        watch.watch(client, key);
      }
      return OK;
    },
  },

  // UNWATCH -> OK. Forgets every watched key.
  UNWATCH: {
    arity: 1,
    run: (_args, client) => {
      watch.unwatchAll(client);
      return OK;
    },
  },
};
