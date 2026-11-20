// The command table: every command's name -> how many arguments it takes and
// the function that runs it. Each file in this folder holds one group.
import type { Reply } from "../resp/encoder.js";
import { type Client, detachedClient } from "../client.js";
import * as store from "../store.js";
import * as eviction from "../eviction.js";
import * as watch from "../watch.js";
import { type Command, WrongTypeError, wrongArgs } from "./shared.js";
import { serverCommands } from "./server.js";
export { onSave } from "./server.js";
import { keyCommands } from "./keys.js";
import { stringCommands } from "./strings.js";
import { listCommands } from "./lists.js";
import { hashCommands } from "./hashes.js";
import { setCommands } from "./sets.js";
import { pubsubCommands } from "./pubsub.js";
import { transactionCommands } from "./transactions.js";

const commands: Record<string, Command> = {
  ...serverCommands,
  ...keyCommands,
  ...stringCommands,
  ...listCommands,
  ...hashCommands,
  ...setCommands,
  ...pubsubCommands,
  ...transactionCommands,

  // EXEC -> an array with the reply of each queued command, in order.
  EXEC: { arity: 1, run: (_args, client) => exec(client) },
};

// Inside MULTI, every command is queued except these, which act right away.
const RUN_DURING_MULTI = new Set(["EXEC", "DISCARD", "MULTI", "WATCH", "QUIT"]);

// Once a client has subscribed to a channel, it's in "subscribed mode" and can
// only use these until it unsubscribes from everything (RESP2's rule).
const ALLOWED_WHILE_SUBSCRIBED = new Set(["SUBSCRIBE", "UNSUBSCRIBE", "PING", "QUIT"]);

// Called with the commands to record every time a write command changes data.
// The AOF listens here; commands don't need to know the AOF exists.
type WriteListener = (commands: string[][]) => void;
let writeListener: WriteListener | null = null;

export function onWrite(listener: WriteListener | null): void {
  writeListener = listener;
}

// While EXEC runs, writes are collected here instead, and then reported as
// one block wrapped in MULTI ... EXEC. The AOF writes the block in one go, and
// a crash part-way through leaves an unfinished MULTI the loader can drop.
let transactionWrites: string[][] | null = null;

function record(commands: string[][]): void {
  if (transactionWrites) transactionWrites.push(...commands);
  else writeListener?.(commands);
}

// `client` is the connection the command came from; commands that don't come
// from one (AOF replay, tests) get a detached client.
export function runCommand(words: string[], client: Client = detachedClient()): Reply {
  const upper = words[0].toUpperCase();
  const command = Object.hasOwn(commands, upper) ? commands[upper] : undefined;
  if (client.transaction && !RUN_DURING_MULTI.has(upper)) return queue(words, client.transaction);

  // Like Redis: before running a command, evict until memory is under the
  // limit. If that isn't possible (noeviction), refuse commands that add data.
  if (command && !store.isLoading()) {
    evictIfNeeded();
    if (command.denyoom && overLimit()) return OOM;
  }
  let reply: Reply;
  try {
    reply = execute(words, client);
    // Every key a successful write touched counts as changed, for WATCH.
    if (command?.write && !isError(reply)) for (const key of store.touchedKeys()) watch.keyModified(key);
  } finally {
    store.settle(); // update the memory estimate for the keys this command touched
  }

  if (writeListener && command?.write && !isError(reply)) {
    const toRecord = command.toAof ? command.toAof(words.slice(1), reply) : [words];
    if (toRecord.length > 0) record(toRecord);
  }
  return reply;
}

function isError(reply: Reply): boolean {
  return reply !== null && typeof reply === "object" && "error" in reply;
}

const OOM: Reply = { error: "OOM command not allowed when used memory > 'maxmemory'." };

function overLimit(): boolean {
  return eviction.maxmemory() > 0 && store.usedMemory() > eviction.maxmemory();
}

// Each evicted key is recorded as a DEL, so the AOF doesn't bring it back.
function evictIfNeeded(): void {
  while (overLimit()) {
    const key = eviction.victim();
    if (key === undefined) return; // noeviction, or nothing left
    store.del(key);
    eviction.countEviction();
    record([["DEL", key]]);
  }
}

// ---- Transactions ----

// A command sent between MULTI and EXEC is checked (does it exist? right
// number of arguments?) and queued. If the check fails, the client gets the
// error now and EXEC will refuse the whole transaction, like Redis.
function queue(words: string[], transaction: NonNullable<Client["transaction"]>): Reply {
  const problem = checkCommand(words);
  if (problem) {
    transaction.failed = true;
    return problem;
  }
  transaction.queue.push(words);
  return { simple: "QUEUED" };
}

// Runs the queued commands one after another. Nothing else can run in between:
// this is all one synchronous call on the single thread, so the transaction
// is atomic without any locking. A command that fails while running (say,
// WRONGTYPE) doesn't stop the others; its error is just one of the replies.
function exec(client: Client): Reply {
  const transaction = client.transaction;
  if (!transaction) return { error: "ERR EXEC without MULTI" };
  client.transaction = null;
  const watchedKeyChanged = client.watchedKeyChanged;
  watch.unwatchAll(client); // EXEC always ends the watch, whether it runs or not
  if (transaction.failed) return { error: "EXECABORT Transaction discarded because of previous errors." };
  if (watchedKeyChanged) return { nullArray: true }; // someone changed a WATCHed key: nothing runs

  transactionWrites = [];
  try {
    return transaction.queue.map((words) => runCommand(words, client));
  } finally {
    const writes = transactionWrites;
    transactionWrites = null;
    if (writes.length > 0) writeListener?.([["MULTI"], ...writes, ["EXEC"]]);
  }
}

// ---- Running one command ----

// The error for an unknown command or the wrong number of arguments, if any.
function checkCommand(words: string[]): Reply | null {
  const [name, ...args] = words;
  const upper = name.toUpperCase();
  if (!Object.hasOwn(commands, upper)) {
    const preview = args.map((arg) => `'${arg}'`).join(" ");
    return { error: `ERR unknown command '${name}', with args beginning with: ${preview}` };
  }
  const command = commands[upper];
  const ok = command.arity > 0 ? words.length === command.arity : words.length >= -command.arity;
  return ok ? null : wrongArgs(name.toLowerCase());
}

function execute(words: string[], client: Client): Reply {
  const problem = checkCommand(words);
  if (problem) return problem;
  const [name, ...args] = words;
  const upper = name.toUpperCase();
  const command = commands[upper];
  if (client.subscriptions.size > 0 && !ALLOWED_WHILE_SUBSCRIBED.has(upper)) {
    return {
      error: `ERR Can't execute '${name.toLowerCase()}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
    };
  }

  try {
    return command.run(args, client);
  } catch (err) {
    if (err instanceof WrongTypeError) {
      return { error: "WRONGTYPE Operation against a key holding the wrong kind of value" };
    }
    throw err;
  }
}
