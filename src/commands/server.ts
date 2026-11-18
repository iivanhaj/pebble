import * as store from "../store.js";
import { type Command, wrongArgs } from "./shared.js";

export const serverCommands: Record<string, Command> = {
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
    ["Persistence", ["loading:0"]], // nothing is loaded from disk yet
    ["Keyspace", keys > 0 ? [`db0:keys=${keys},expires=${store.expiringCount()},avg_ttl=0`] : []],
  ];
}
