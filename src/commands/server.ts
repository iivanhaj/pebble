import * as store from "../store.js";
import { type Command, OK, wrongArgs } from "./shared.js";

// SAVE calls this to write a snapshot. Startup code registers it, so commands
// don't need to know where files live.
let saveHandler: (() => void) | null = null;
let lastSave = Math.floor(Date.now() / 1000); // like Redis: starts at server start time

export function onSave(handler: (() => void) | null): void {
  saveHandler = handler;
}

export const serverCommands: Record<string, Command> = {
  // SAVE -> writes a snapshot now. Blocks every client until it's done.
  SAVE: {
    arity: 1,
    run: () => {
      if (!saveHandler) return { error: "ERR snapshots are not set up" };
      try {
        saveHandler();
      } catch (err) {
        return { error: `ERR snapshot failed: ${(err as Error).message}` };
      }
      lastSave = Math.floor(Date.now() / 1000);
      return OK;
    },
  },

  // LASTSAVE -> unix time (seconds) of the last successful SAVE
  LASTSAVE: { arity: 1, run: () => lastSave },

  // DBSIZE -> number of keys (expired ones not cleaned up yet still count, like Redis)
  DBSIZE: { arity: 1, run: () => store.size() },

  PING: {
    arity: -1,
    run: (args) => {
      if (args.length > 1) return wrongArgs("ping");
      return args.length === 0 ? { simple: "PONG" } : args[0];
    },
  },
  ECHO: { arity: 2, run: ([message]) => message },

  // INFO [section ...] -> "# Section\r\nfield:value\r\n..." as one bulk string.
  // Clients like ioredis send INFO on connect and wait until "loading:0".
  INFO: {
    arity: -1,
    run: (args) => {
      const wanted = args.map((arg) => arg.toLowerCase());
      const showAll = wanted.length === 0 || wanted.some((w) => ["all", "everything", "default"].includes(w));
      return infoSections()
        .filter(([name]) => showAll || wanted.includes(name.toLowerCase()))
        .map(([name, fields]) => `# ${name}\r\n${fields.map((field) => `${field}\r\n`).join("")}`)
        .join("\r\n");
    },
  },
};

function infoSections(): [string, string[]][] {
  const keys = store.size();
  return [
    ["Server", ["pebble_version:0.1.0", `process_id:${process.pid}`, `uptime_in_seconds:${Math.floor(process.uptime())}`]],
    ["Persistence", ["loading:0", `rdb_last_save_time:${lastSave}`]], // loading finishes before clients connect
    ["Keyspace", keys > 0 ? [`db0:keys=${keys},expires=${store.expiringCount()},avg_ttl=0`] : []],
  ];
}
