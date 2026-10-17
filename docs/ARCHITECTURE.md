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
3. **The command table is a plain object** mapping a command name to a function.
   Unknown names reply with an error.
4. **Expiry times live in a second Map** (`key → expires-at timestamp`), next to
   the notebook. Keys with no timeout are not in it.

## Files (week 1)

```
src/
  main.ts           starts the server on port 6380
  server.ts         creates the TCP server, one Connection per client
  connection.ts     leftovers buffer + parse/run/reply loop
  resp/parser.ts    bytes → ["SET", "name", "Jahnavi"]
  resp/encoder.ts   "OK" → "+OK\r\n"
  commands.ts       the command table
  store.ts          the notebook Map (+ expiry Map later)
```

Later milestones (expiry, LRU eviction, AOF, snapshots, pub/sub, transactions)
add new files beside these without changing their shape.
