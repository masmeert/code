import { HostRoom } from "./host-room.ts";

export { HostRoom };

interface Env {
  readonly HOST_ROOMS: DurableObjectNamespace<HostRoom>;
  readonly CONNECT_LIMITER?: RateLimit;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") return new Response("MassCode relay");

    const hostId = /^\/hosts\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)?.[1];

    if (!hostId) return new Response("Not found", { status: 404 });

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket upgrade", { status: 426 });

    const role = url.searchParams.get("role");

    if (role !== "host" && role !== "phone") return new Response("Unknown role", { status: 400 });

    const limit = await env.CONNECT_LIMITER?.limit({
      key: request.headers.get("cf-connecting-ip") ?? "local",
    });

    if (limit && !limit.success)
      return new Response("Too many connections, try again in a minute", { status: 429 });

    return env.HOST_ROOMS.getByName(hostId).fetch(request);
  },
} satisfies ExportedHandler<Env>;
