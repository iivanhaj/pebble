# Architecture

Pebble works like a clerk at a counter: a client walks up, the clerk reads the
request, does what it asks using a notebook, and answers.

```mermaid
flowchart LR
  C[Client<br/>redis-cli] --> CO[Connection<br/>reads + parses]
  CO --> T[Command table<br/>name → function]
  T --> N[(Notebook<br/>a Map)]
  T -. reply, e.g. +OK .-> C
```

## What happens to one command

1. **Connect.** A client opens a TCP connection to port 6380.
2. **Read.** Bytes arrive in RESP format, e.g.
   `*3\r\n$3\r\nSET\r\n$4\r\nname\r\n$7\r\nJahnavi\r\n`.
   The connection keeps a leftovers buffer, because a command can arrive in
   pieces, or two commands can arrive in one chunk. The parser returns one
   whole command, or `null` if it needs more bytes.
3. **Run.** The command table looks up the first word (`SET`) and calls its
   function, which reads or writes the notebook.
4. **Reply.** The encoder turns the result into RESP (`+OK\r\n`) and writes it
   back to the socket.

## Design decisions

1. **One clerk, never pauses mid-task.** Node runs on one thread, and command
   functions never `await`. Each command finishes before the next starts, so
   commands are atomic without locks.
2. **Strings, one character per byte.** Bytes are decoded with `latin1`, which
   maps each byte to exactly one character. Any data (even binary) round-trips
   unchanged, and a RESP `$7` length always equals the string's `.length`.
3. **The command table is a plain object** mapping a command name to a function,
   split into one file per group under `commands/`. Unknown names reply with an
   error.
4. **Expiry times live in a second Map** (`key → expires-at timestamp`), next to
   the notebook. Keys with no timeout are not in it. The same keys are also kept
   in an array, so active expiry can pick a random one in O(1); removing a key
   swaps the last one into its slot.

## Data types

A key holds one of four kinds of value:

| Type   | Stored as             | Commands                                        |
|--------|-----------------------|-------------------------------------------------|
| string | `string`              | GET, SET, INCR, DECR, MGET, MSET                |
| list   | `Deque<string>`       | LPUSH, RPUSH, LPOP, RPOP, LRANGE                |
| hash   | `Map<string, string>` | HSET, HGET, HGETALL, HDEL                       |
| set    | `Set<string>`         | SADD, SREM, SMEMBERS, SISMEMBER                 |

- **Lists use a deque, not an array.** `array.unshift()` and `shift()` move
  every other item, so LPUSH/LPOP would be O(n). The deque is a circular
  buffer: O(1) at both ends, doubling in size when full.
- **Wrong type → WRONGTYPE.** Commands read keys through typed getters
  (`getList`, `getHash`, ...) that throw if the key holds another type;
  `runCommand` turns that into Redis's `WRONGTYPE` error. The check happens
  before anything changes, so a failed command leaves the key untouched.
- **No empty collections.** Removing the last item from a list, hash or set
  deletes the key, like Redis.

## Expiry

Like Redis, expired keys are removed two ways:

- **Lazily:** every read of a key checks its timeout first and deletes it if
  it has passed. Cheap, but a key nobody reads again would stay forever.
- **Actively:** 10 times a second, sample 20 random keys that have a timeout
  and delete the expired ones. If more than a quarter of the sample had
  expired, sample again right away (up to a 25 ms time budget).

## Persistence: the append-only file (AOF)

With `--appendonly yes`, every command that changes data is appended to
`appendonly.aof`, and on startup the file is replayed from the top to rebuild
the data. The file uses RESP, the same format clients send, so writing it
reuses the encoder and reading it reuses the parser.

- **What gets recorded.** Commands flagged `write` in the command table report
  each change through `onWrite`; the AOF listens there. Commands that changed
  nothing (an error, a `SET NX` that didn't set) record nothing.
- **Timeouts are recorded as absolute times.** `SET k v EX 10` and `EXPIRE` are
  written as `PEXPIREAT k <unix ms>`, so a restart doesn't restart the
  countdown.
- **Nothing expires while loading.** A key's later commands in the file
  happened before its deadline, so it must still exist when they replay.
  Otherwise `SET k 1`, `PEXPIREAT k <past>`, `INCR k` would delete `k` and then
  recreate it with no timeout. Expired keys are cleaned up normally once
  loading is done.
- **Order on startup:** load the file first, then start recording, so replayed
  commands aren't written to the file again.
- **A half-written last command** (the server died mid-write) is cut off and
  loading continues, like Redis's default `aof-load-truncated yes`. Anything
  else unreadable refuses to start.

### fsync policies (`--appendfsync`)

Writing to a file only puts bytes in the OS's memory; the OS copies them to the
disk later. `fsync` forces that copy now, and waits for the disk.

| Policy     | When it fsyncs                         | Lost if the machine loses power |
|------------|----------------------------------------|---------------------------------|
| `always`   | after every write, before replying     | nothing                         |
| `everysec` | once a second, on Node's thread pool   | up to ~1 second (default)       |
| `no`       | never; the OS decides                  | up to ~30 seconds on Linux      |

If only Pebble crashes (`kill -9`), no policy loses anything: the bytes are
already in the OS's memory and still reach the disk. `crash.test.ts` checks
this: it kills a real Pebble process mid-stream and verifies every write the
client got a reply for survives the restart.

## Files

```
src/
  main.ts                starts the server, loads the AOF, active expiry timer
  config.ts              command-line settings (--port, --appendonly, ...)
  server.ts              creates the TCP server, one Connection per client
  connection.ts          leftovers buffer + parse/run/reply loop
  resp/parser.ts         bytes → ["SET", "name", "Jahnavi"]
  resp/encoder.ts        "OK" → "+OK\r\n"
  commands/index.ts      the command table, runCommand, onWrite
  commands/shared.ts     command type, errors, typed getters
  commands/*.ts          server, keys, strings, lists, hashes, sets
  store.ts               the notebook Map, expiry times, lazy + active expiry
  deque.ts               circular buffer used for lists
  persistence/aof.ts     AOF writer (with fsync policies) and loader
```

Later milestones (snapshots, LRU eviction, pub/sub, transactions)
add new files beside these without changing their shape.
