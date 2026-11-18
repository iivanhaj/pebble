// On startup: rebuild the data from disk, then start saving new changes.
//
//   1. Load the snapshot, if there is one.
//   2. Replay the AOF, starting where the snapshot left off: the snapshot
//      records how big the AOF was when it was taken, and everything before
//      that point is already in it. (Replaying it again would apply INCRs twice.)
//   3. Start recording writes to the AOF, and register what SAVE does.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { onWrite, onSave } from "../commands/index.js";
import * as store from "../store.js";
import { AofWriter, loadAof } from "./aof.js";
import { loadSnapshot, saveSnapshot, type SnapshotInfo } from "./snapshot.js";

export type Persistence = { messages: string[]; close: () => void };

export function startPersistence(config: Config): Persistence {
  const messages: string[] = [];
  const snapshotPath = path.join(config.dir, config.dbfilename);
  const aofPath = path.join(config.dir, config.appendfilename);

  let snapshot: SnapshotInfo | null = null;
  if (fs.existsSync(snapshotPath)) {
    snapshot = loadSnapshot(snapshotPath);
    messages.push(`Loaded ${snapshot.keys} keys from snapshot ${snapshotPath}`);
  }

  let aof: AofWriter | null = null;
  if (config.appendonly) {
    const aofExisted = fs.existsSync(aofPath);
    let from = 0;
    if (snapshot && aofExisted) {
      if (snapshot.aofOffset >= 0) {
        from = snapshot.aofOffset;
      } else {
        // The snapshot was taken without an AOF, so we can't tell which AOF
        // entries it already has. Like Redis, the AOF wins: it has every write.
        store.clear();
        messages.push("Snapshot has no AOF position; loading the whole AOF instead");
      }
    }

    const loaded = loadAof(aofPath, from);
    messages.push(`Replayed ${loaded.commands} commands from ${aofPath}` + (from > 0 ? ` (from byte ${from})` : ""));
    if (loaded.truncatedBytes > 0) {
      messages.push(`The AOF ended with a half-written command; cut off its last ${loaded.truncatedBytes} bytes`);
    }

    aof = new AofWriter(aofPath, config.appendfsync);
    const writer = aof;
    onWrite((commands) => writer.append(commands));
    messages.push(`Recording writes to ${aofPath} (appendfsync ${config.appendfsync})`);
  }

  const save = () => saveSnapshot(snapshotPath, aof ? aof.size : -1);
  onSave(save);

  // Data came from a snapshot into a brand-new AOF: the AOF doesn't have it.
  // Take a fresh snapshot that points at the start of the new AOF, so the
  // next restart loads both correctly.
  if (aof && snapshot && aof.size === 0 && store.size() > 0) {
    save();
    messages.push("Saved a new snapshot to go with the new AOF");
  }

  return {
    messages,
    close: () => {
      onWrite(null);
      onSave(null);
      aof?.close();
    },
  };
}
