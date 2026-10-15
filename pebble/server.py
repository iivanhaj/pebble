import asyncio

HOST = "127.0.0.1"
PORT = 6380


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(1024):
            # No RESP parsing yet: answer every chunk of input with PONG.
            writer.write(b"+PONG\r\n")
            await writer.drain()
    except ConnectionResetError:
        pass
    finally:
        writer.close()


async def main() -> None:
    server = await asyncio.start_server(handle_client, HOST, PORT)
    print(f"Pebble listening on {HOST}:{PORT}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
