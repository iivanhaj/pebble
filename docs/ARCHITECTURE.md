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

## Persistence: snapshots

The AOF never loses anything, but it grows forever and replaying it gets
slower. A snapshot is the whole store saved to one compact file at one moment
(`SAVE`, written to `dump.pebble`).

**Format.** Pebble's own binary format, not Redis's RDB: a `PEBBLE01` header,
one record per key (type, absolute expiry time, key, value), an end marker,
and a CRC32 checksum over everything. A damaged or cut-off file is refused at
startup rather than loaded wrong.

**Atomic save.** The snapshot is written to `dump.pebble.tmp`, fsynced, then
renamed over `dump.pebble`. A rename replaces the file in one step, so a crash
at any moment leaves the old snapshot or the new one, never half of one.

**Startup order** (`persistence/startup.ts`):

1. Load the snapshot, if there is one.
2. Replay the AOF from where the snapshot left off. Each snapshot records the
   AOF's size when it was taken; everything before that is already in it.
   Replaying it again would apply `INCR`s twice.
3. Start recording to the AOF and register what `SAVE` does.

Edge cases: a snapshot taken while the AOF was off has no AOF position, so if
an AOF exists it wins (it has every write), like Redis. If the AOF is new but
data came from a snapshot, a fresh snapshot pointing at the empty AOF is saved
right away. An AOF shorter than the snapshot expects refuses to start.

**Why `SAVE` blocks, and what it costs.** Real Redis's `BGSAVE` calls
`fork()`: the child process gets a frozen copy of memory for free (the OS
copies pages only when the parent changes them) and writes it out while the
parent keeps serving clients. Node can't fork like that, so `SAVE` runs on the
main thread and every client waits. Measured on a laptop:

| Keys      | `SAVE` blocks for | Load at startup | File size |
|-----------|-------------------|-----------------|-----------|
| 10,000    | ~0.1 s            | ~0.02 s         | 0.5 MB    |
| 100,000   | ~0.2 s            | ~0.1 s          | 5.4 MB    |
| 1,000,000 | ~1.3 s            | ~1.4–1.8 s      | 55.8 MB   |

At 1M keys, ~0.9–1.2 s of the save is turning the data into bytes; writing
and fsyncing the file is the rest. So a non-blocking save that encodes in
small chunks between client requests would remove most of the pause. The
catch is keys changing while the save is half done, which is the next design
problem.

## Memory limit and eviction

`--maxmemory 100mb` caps memory; `--maxmemory-policy` decides what happens at
the cap. Like Redis, the check runs before each command: if memory is over the
limit, keys are evicted until it isn't. Each eviction is recorded in the AOF
as a `DEL`, so a restart doesn't bring evicted keys back.

### Measuring memory

JS can't tell you how big one object is, and the process heap jumps around
with garbage collection, so Pebble keeps its own estimate (`values.ts`): the
characters in a key and its value, plus a fixed overhead per key and per item.
The overheads were set by measuring V8's real heap growth with 100k–1M keys of
each type, and the estimate lands within 2% of it:

| Per…           | Overhead  | Why                                   |
|----------------|-----------|---------------------------------------|
| key            | 115 bytes | the Map entry, the key and value objects |
| list item      | 40 bytes  | an array slot and a string            |
| hash field     | 120 bytes | a hash table entry and two strings    |
| set member     | 115 bytes | a hash table entry and a string       |

Commands change lists, hashes and sets in place, so the store can't see each
change as it happens. Instead, lists, hashes and sets count their own
characters as items go in and out, every key a command touches is noted, and
after the command `settle()` re-measures just those keys: O(1) per key, even
for a million-item list. A test runs 5,000 random commands and checks the
running total against a full recount after every one.

### Policies

| Policy              | What it evicts                                        |
|---------------------|-------------------------------------------------------|
| `noeviction`        | nothing; commands that add data get `OOM` (default)   |
| `allkeys-lru`       | sampled LRU: of N random keys (default 5), the one used longest ago |
| `allkeys-lru-exact` | exact LRU: always the least recently used key         |
| `allkeys-random`    | any random key                                        |

**Exact LRU** (`lru-list.ts`) is the classic hash map + doubly linked list:
the list keeps keys in order of use, the map finds any key's node, so marking
a key used, removing one and finding the oldest are all O(1).

**Sampled LRU** is what real Redis does. No ordered list: each key just
remembers when it was last used (a counter), and to evict, it looks at a few
random keys and takes the oldest of those. It needs a way to pick a random key
in O(1) (keys in an array, plus key → position) and one number per key.

### Comparing them

`npm run bench:eviction`: Pebble as a cache with room for 10% of 100,000 keys,
hit with 1,000,000 requests whose popularity follows a Zipf distribution
(a few hot keys, a long tail), the shape real traffic tends to have. On a miss
the key is stored, which may evict another.

| Policy                         | Hit rate | Requests/sec | Bookkeeping per key |
|--------------------------------|----------|--------------|---------------------|
| `allkeys-lru-exact`            | 73.54%   | ~700k        | 77 bytes            |
| `allkeys-lru`, 10 samples      | 73.43%   | ~720k        | 50 bytes            |
| `allkeys-lru`, 5 samples       | 73.17%   | ~780k        | 50 bytes            |
| `allkeys-lru`, 3 samples       | 72.71%   | ~790k        | 50 bytes            |
| `allkeys-random`               | 70.05%   | ~810k        | 40 bytes            |

What it shows: Redis's sampled LRU with its default 5 samples gets within 0.4
points of exact LRU's hit rate, with a third less bookkeeping memory, and runs
faster, because a read only updates one number instead of relinking list
nodes. That's why Redis approximates. Random eviction is only ~3.5 points
behind here because, with a skewed workload, the hot keys get re-added
quickly after being evicted; less skewed traffic widens the gap.

## Pub/sub

`SUBSCRIBE news` tunes a client in to a channel; `PUBLISH news hello` sends
`["message", "news", "hello"]` to every client tuned in right now and returns
how many got it. Nothing is stored: with no listeners, the message is dropped.

This is the first feature where a command isn't just "one request in, one
reply out", so it needed three pieces of plumbing:

- **Commands know who's asking.** Each command gets the `Client` it came from
  (`client.ts`): a way to send to that connection, and its subscriptions.
  Commands from the AOF or tests get a detached client.
- **One command, several replies.** `SUBSCRIBE a b` confirms each channel
  separately, as Redis does. A reply can be `{ sequence: [...] }`, which the
  encoder sends as separate replies back to back.
- **Sending to other connections.** `pubsub.ts` maps each channel to the set of
  clients listening; `PUBLISH` calls `send` on each. Each client also keeps its
  own set of channels, so when its socket closes it's removed from every
  channel in one go (otherwise `PUBLISH` would keep writing to dead sockets).

**Subscribed mode.** Like Redis with RESP2, once a client subscribes it can
only use `SUBSCRIBE`, `UNSUBSCRIBE`, `PING` (which then replies
`["pong", ""]`) and `QUIT`, until it unsubscribes from everything. Anything
else gets Redis's exact error.

**Slow subscribers.** A subscriber that stops reading makes messages pile up
in Pebble's memory, waiting to be sent (`socket.writableLength`). With Redis's
defaults (`client-output-buffer-limit pubsub 32mb 8mb 60`), a subscriber is
disconnected when more than 32 MB is waiting, or more than 8 MB for over 60
seconds. A test pauses a real subscriber socket and publishes 1 MB messages
until it's dropped. Ordinary clients have no limit, as in Redis.

## Transactions

**MULTI / EXEC / DISCARD.** After `MULTI`, a client's commands are queued
(each replies `QUEUED`) instead of run. `EXEC` runs them all and returns every
reply; `DISCARD` throws them away. EXEC runs the queue in one synchronous call
on the single thread, so no other client's command can land in between: the
transaction is atomic without any locks. Like Redis:

- A command rejected while queuing (unknown, wrong number of arguments) is
  reported right away, and `EXEC` then refuses the whole transaction with
  `EXECABORT`.
- A command that fails while running (say, `WRONGTYPE`) doesn't stop the
  others; its error is just one of the replies. There's no rollback.

**WATCH: optimistic locking.** `WATCH key` before `MULTI` means: if anyone
changes this key before my `EXEC`, don't run anything (`EXEC` replies nil) and
I'll retry. Nobody ever waits for a lock; the cost is a retry when two clients
collide. `watch.ts` maps each key to the clients watching it, and flags them
when it changes. Changes are reported from two places, so none are missed:

- `runCommand`, for every key a successful write command touched (this
  catches lists, hashes and sets changed in place, which the store can't see);
- the store, whenever it removes a key (`DEL`, expiry, eviction).

That's deliberately cautious: a write that touched a key without changing it
(a `SET NX` that didn't set) still counts, so the worst case is an unneeded
retry, never a missed change. Every `EXEC` (whether it ran or not), `DISCARD`
and `UNWATCH` ends the watch.

**Transactions in the AOF.** While `EXEC` runs, its writes are collected and
recorded as one block, `MULTI`, the commands, `EXEC`, written in one go. The
loader replays the file as a single client, so the block replays as a
transaction. If the file ends inside a block (crashed mid-write), the loader
cuts it back to before the `MULTI`: the transaction is either all there or
not at all.

## Files

```
src/
  main.ts                parses settings, starts persistence, then the server
  config.ts              command-line settings (--port, --appendonly, ...)
  server.ts              creates the TCP server, one Connection per client
  connection.ts          leftovers buffer + parse/run/reply loop, subscriber limits
  client.ts              the connection a command came from
  pubsub.ts              channel -> listening clients; PUBLISH fan-out
  watch.ts               WATCH: key -> watching clients; flags them on change
  resp/parser.ts         bytes → ["SET", "name", "Jahnavi"]
  resp/encoder.ts        "OK" → "+OK\r\n"
  commands/index.ts      the command table, runCommand, onWrite, eviction check, EXEC
  commands/shared.ts     command type, errors, typed getters
  commands/*.ts          server, keys, strings, lists, hashes, sets, pubsub, transactions
  store.ts               the notebook Map, expiry, memory estimate
  values.ts              list/hash/set types that count their bytes; sizeOf
  deque.ts               circular buffer used for lists
  random-key-set.ts      a set you can pick a random key from in O(1)
  lru-list.ts            exact LRU: hash map + doubly linked list
  eviction.ts            maxmemory policies
  persistence/aof.ts       AOF writer (with fsync policies) and loader
  persistence/snapshot.ts  snapshot file format, atomic save, load
  persistence/startup.ts   startup order: snapshot, then the AOF after it
  bench/eviction-bench.ts  hit rate and memory comparison of the policies
```

Next: benchmarks against real Redis with `redis-benchmark`.
