// Settings from the command line, named like real Redis's:
//   npm start -- --port 6380 --appendonly yes --dir ./data
import type { FsyncPolicy } from "./persistence/aof.js";
import { POLICIES, type EvictionPolicy } from "./eviction.js";

export type Config = {
  port: number;
  dir: string; // where the AOF and snapshot live
  dbfilename: string; // the snapshot file
  appendonly: boolean; // record writes to the AOF? (off by default, like Redis)
  appendfilename: string;
  appendfsync: FsyncPolicy; // when to force the AOF onto the disk; see persistence/aof.ts
  maxmemory: number; // bytes; 0 = no limit
  maxmemoryPolicy: EvictionPolicy; // what to do at the limit; see eviction.ts
  maxmemorySamples: number; // keys allkeys-lru looks at per eviction
};

const defaults: Config = {
  port: 6380,
  dir: ".",
  dbfilename: "dump.pebble",
  appendonly: false,
  appendfilename: "appendonly.aof",
  appendfsync: "everysec",
  maxmemory: 0,
  maxmemoryPolicy: "noeviction",
  maxmemorySamples: 5,
};

// "100mb" -> 104857600. Units as in redis.conf: k = 1000, kb = 1024, m = 1000^2,
// mb = 1024^2, g = 1000^3, gb = 1024^3. No unit means bytes.
export function parseMemory(text: string): number {
  const match = /^(\d+)(b|k|kb|m|mb|g|gb)?$/i.exec(text);
  if (!match) throw new Error(`Invalid memory size: ${text}`);
  const units: Record<string, number> = { b: 1, k: 1e3, kb: 1024, m: 1e6, mb: 1024 ** 2, g: 1e9, gb: 1024 ** 3 };
  return Number(match[1]) * units[(match[2] ?? "b").toLowerCase()];
}

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
      case "maxmemory":
        config.maxmemory = parseMemory(value);
        break;
      case "maxmemory-policy":
        if (!POLICIES.includes(value as EvictionPolicy)) {
          throw new Error(`--maxmemory-policy must be one of ${POLICIES.join(", ")}, got "${value}"`);
        }
        config.maxmemoryPolicy = value as EvictionPolicy;
        break;
      case "maxmemory-samples":
        config.maxmemorySamples = Number(value);
        if (!Number.isInteger(config.maxmemorySamples) || config.maxmemorySamples < 1) {
          throw new Error(`--maxmemory-samples must be a whole number of at least 1, got "${value}"`);
        }
        break;
      default:
        throw new Error(`Unknown setting: --${name}`);
    }
  }
  return config;
}
