import net from "node:net";
import { handleConnection } from "./connection.js";

export function createServer(): net.Server {
  return net.createServer(handleConnection);
}
