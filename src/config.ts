// Settings from the command line, named like real Redis's:
//   npm start -- --port 6380 --appendonly yes --dir ./data
import type { FsyncPolicy } from "./persistence/aof.js";

export type Config = {
  port: number;
  dir: string; // where the AOF and snapshot live
  dbfilename: string; // the snapshot file
  appendonly: boolean; // record writes to the AOF? (off by default, like Redis)
  appendfilename: string;
  appendfsync: FsyncPolicy; // when to force the AOF onto the disk; see persistence/aof.ts
};

const defaults: Config = {
  port: 6380,
  dir: ".",
  dbfilename: "dump.pebble",
  appendonly: false,
  appendfilename: "appendonly.aof",
  appendfsync: "everysec",
};

export function parseArgs(argv: string[]): Config {
  const config = { ...defaults };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (!argv[i].startsWith("--") || value === undefined) {
      throw new Error(`Expected "--name value", got "${argv.slice(i).join(" ")}"`);
    }
    switch (name) {
      case "port":
        config.port = Number(value);
        if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
          throw new Error(`Invalid port: ${value}`);
        }
        break;
      case "dir":
        config.dir = value;
        break;
      case "dbfilename":
        config.dbfilename = value;
        break;
      case "appendonly":
        if (value !== "yes" && value !== "no") throw new Error(`--appendonly must be yes or no, got "${value}"`);
        config.appendonly = value === "yes";
        break;
      case "appendfilename":
        config.appendfilename = value;
        break;
      case "appendfsync":
        if (value !== "always" && value !== "everysec" && value !== "no") {
          throw new Error(`--appendfsync must be always, everysec or no, got "${value}"`);
        }
        config.appendfsync = value;
        break;
      default:
        throw new Error(`Unknown setting: --${name}`);
    }
  }
  return config;
}
