import { type AddressInfo, createServer } from "node:net";

export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        // SAFETY: a TCP server listening on a host and port reports an AddressInfo, not a pipe path.
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
  });
}
