// Settings from the command line, named like real Redis's:
//   npm start -- --port 6380 --appendonly yes --dir ./data
export type Config = {
  port: number;
  dir: string; // where the AOF lives
  appendonly: boolean; // record writes to the AOF? (off by default, like Redis)
  appendfilename: string;
};

const defaults: Config = {
  port: 6380,
  dir: ".",
  appendonly: false,
  appendfilename: "appendonly.aof",
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
      case "appendonly":
        if (value !== "yes" && value !== "no") throw new Error(`--appendonly must be yes or no, got "${value}"`);
        config.appendonly = value === "yes";
        break;
      case "appendfilename":
        config.appendfilename = value;
        break;
      default:
        throw new Error(`Unknown setting: --${name}`);
    }
  }
  return config;
}
