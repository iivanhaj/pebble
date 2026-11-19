# Pebble

[![test](https://github.com/iivanhaj/pebble/actions/workflows/test.yml/badge.svg)](https://github.com/iivanhaj/pebble/actions/workflows/test.yml)

A Redis-compatible server, written from scratch in TypeScript on Node.js.
Real Redis clients, like `redis-cli` and the `ioredis` library, talk to it
without knowing it isn't Redis.

I'm building it to learn how Redis works on the inside: the wire protocol,
key expiry, data structures, persistence, and how a single-threaded server
can still be fast. It's a work in progress; see the [roadmap](#roadmap).

## Quick start

Needs Node.js 22 or newer.

```bash
npm install
npm run build
npm start          # listens on 127.0.0.1:6380
```

To keep data across restarts, turn on the append-only file (settings are
named like Redis's). `SAVE` also writes a snapshot of everything to
`dump.pebble`, which is loaded on startup:

```bash
npm start -- --appendonly yes --appendfsync everysec
```

To use it as a cache with a memory limit, evicting the least recently used
keys when full:

```bash
npm start -- --maxmemory 100mb --maxmemory-policy allkeys-lru
```

Then connect with `redis-cli` (or, without installing Redis, through Docker):

```bash
redis-cli -p 6380
docker run --rm -it redis:7-alpine redis-cli -h host.docker.internal -p 6380
```

```
127.0.0.1:6380> SET name Jahnavi EX 60
OK
127.0.0.1:6380> TTL name
(integer) 60
127.0.0.1:6380> RPUSH queue a b c
(integer) 3
127.0.0.1:6380> LRANGE queue 0 -1
1) "a"
2) "b"
3) "c"
127.0.0.1:6380> GET queue
(error) WRONGTYPE Operation against a key holding the wrong kind of value
```

## What works

| Group      | Commands                                                      |
|------------|---------------------------------------------------------------|
| Server     | `PING`, `ECHO`, `INFO`, `DBSIZE`, `SAVE`, `LASTSAVE`          |
| Keys       | `DEL`, `EXISTS`, `EXPIRE`, `PEXPIREAT`, `TTL`, `PERSIST`      |
| Strings    | `GET`, `SET` (with `EX`, `PX`, `NX`, `XX`), `INCR`, `DECR`, `MGET`, `MSET` |
| Lists      | `LPUSH`, `RPUSH`, `LPOP`, `RPOP`, `LRANGE`                    |
| Hashes     | `HSET`, `HGET`, `HGETALL`, `HDEL`                             |
| Sets       | `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`                       |

Replies and error messages match real Redis, so existing client libraries
work unchanged.

## How it works

```mermaid
flowchart LR
  C[Client<br/>redis-cli, ioredis] --> CO[Connection<br/>reads + parses RESP]
  CO --> T[Command table<br/>name → function]
  T --> N[(Keyspace<br/>Map + expiry times)]
  T -. reply .-> C
```

- **One thread, no locks.** Like Redis, Pebble runs every command on a single
  event loop, and a command never pauses partway through. Each one finishes
  before the next starts, so every command is atomic without any locking.
- **A protocol parser that handles partial reads.** TCP can split one command
  across several packets, or pack several commands into one. The parser keeps
  leftover bytes and only runs a command once all of it has arrived.
- **Expiry, two ways.** Expired keys are deleted when someone reads them
  (lazy), and by a background sweep that samples random keys 10 times a second
  (active), the same approach Redis uses.
- **Lists on a circular buffer.** Pushing and popping at either end is O(1),
  where a plain JavaScript array would be O(n) at the front.
- **Persistence with an append-only file.** Every write is appended to a file
  in the same protocol clients speak, and replayed on startup. Timeouts are
  stored as absolute times so they keep counting down across restarts, and a
  crash test kills a real server mid-write to check no acknowledged write is
  ever lost.
- **Snapshots.** `SAVE` writes the whole store to a compact binary file with a
  checksum, atomically (temp file, fsync, rename). On startup Pebble loads the
  snapshot, then replays only the part of the AOF written after it. Measured
  cost: `SAVE` pauses the server ~1.3 s at 1M keys, since Node can't `fork()`
  the way Redis does for background saves.
- **A memory limit with LRU eviction, measured.** Pebble estimates each key's
  memory (calibrated to within 2% of V8's real heap) and evicts when over
  `--maxmemory`. It has both the textbook exact LRU (hash map + doubly linked
  list) and Redis's sampled LRU. A benchmark with skewed, realistic traffic
  shows sampled LRU gets within 0.4 points of exact LRU's hit rate (73.2% vs
  73.5%) with a third less bookkeeping memory, which is why Redis approximates.

More detail, including the design decisions, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests

```bash
npm test
```

147 tests: unit tests for the parser, encoder and every command; end-to-end
tests over a real TCP connection (including a command split across packets);
tests that drive Pebble with the real `ioredis` client; and a crash test that
`kill -9`s a running server under load and restarts it. They run on every push
in GitHub Actions.

```bash
npm run bench:eviction   # hit rate and memory cost of each eviction policy
```

## Roadmap

- [x] RESP2 protocol, including partial reads
- [x] Strings, `INCR`/`DECR`, `MGET`/`MSET`
- [x] Key expiry: lazy and active
- [x] Lists, hashes and sets
- [x] Persistence: append-only file with `always` / `everysec` / `no` fsync policies
- [x] Point-in-time snapshots (`SAVE`), loaded together with the AOF
- [ ] Non-blocking snapshots, without `fork()`
- [x] Memory limit with LRU eviction: exact LRU and Redis-style sampled LRU, compared
- [ ] Pub/sub
- [ ] Transactions: `MULTI` / `EXEC` / `WATCH`
- [ ] Benchmarks against real Redis with `redis-benchmark`

## License

[MIT](LICENSE)
