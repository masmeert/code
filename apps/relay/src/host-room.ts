import { DurableObject } from "cloudflare:workers";
import { HOST_OFFLINE, RelayControl } from "@masscode/contracts";
import {
  decodeBase64Url,
  encodeBase64Url,
  openEnvelope,
  sealEnvelope,
  verifyRelayChallenge,
} from "@masscode/secure-channel";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A Noise message (64 KiB) plus its envelope, with room to spare; anything bigger isn't MassCode's. */
const MAX_MESSAGE_BYTES = 128 * 1024;

const MAX_PHONES = 8;

/** Hosts connected but not yet proven, so a stranger can't fill the room while the real host is away. */
const MAX_UNPROVEN_HOSTS = 4;

const UNPROVEN = 4401;

const REPLACED = 4409;

const TOO_MANY = 4429;

const MESSAGE_TOO_BIG = 1009;

const UNSUPPORTED = 1003;

const decodeControl = Schema.decodeUnknownOption(Schema.fromJsonString(RelayControl));

interface HostAttachment {
  readonly role: "host";
  readonly nonce: string;
  readonly proven: boolean;
}

interface PhoneAttachment {
  readonly role: "phone";
  readonly channel: number;
}

function attachmentOf(socket: WebSocket) {
  // SAFETY: every socket in this room was accepted with one of these attachments.
  return socket.deserializeAttachment() as HostAttachment | PhoneAttachment;
}

function isProven(host: WebSocket) {
  const attachment = attachmentOf(host);

  return attachment.role === "host" && attachment.proven;
}

function sendControl(socket: WebSocket, message: RelayControl) {
  socket.send(JSON.stringify(message));
}

function closeQuietly(socket: WebSocket, code: number, reason: string) {
  try {
    socket.close(code, reason);
  } catch {
    // Already closing.
  }
}

/**
 * One host's meeting point, named by its id. It pipes each phone's bytes to the host inside an
 * envelope naming the phone's channel, and back. It never sees inside them: they're Noise messages
 * only the phone and the host can open. Sockets hibernate between messages, so an idle room costs
 * nothing.
 */
export class HostRoom extends DurableObject {
  constructor(context: DurableObjectState, env: Cloudflare.Env) {
    super(context, env);
    context.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request) {
    const role = new URL(request.url).searchParams.get("role");
    const [client, server] = Object.values(new WebSocketPair());

    if (role === "host") {
      if (this.hosts().filter((socket) => !isProven(socket)).length >= MAX_UNPROVEN_HOSTS)
        return new Response("Too many hosts connecting", { status: 429 });

      const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      this.ctx.acceptWebSocket(server!, ["host"]);
      server!.serializeAttachment({ role: "host", nonce, proven: false } satisfies HostAttachment);
      sendControl(server!, RelayControl.cases.challenge.make({ nonce }));
    } else {
      const host = this.provenHost();
      const channel = this.unusedChannel();
      this.ctx.acceptWebSocket(server!, ["phone", `channel:${channel}`]);
      server!.serializeAttachment({ role: "phone", channel } satisfies PhoneAttachment);

      if (!host) closeQuietly(server!, HOST_OFFLINE, "Your computer isn't connected to the relay");
      else if (this.ctx.getWebSockets("phone").length > MAX_PHONES)
        closeQuietly(server!, TOO_MANY, "Too many phones are connected to this computer");
      else sendControl(host, RelayControl.cases.open.make({ channel }));
    }

    return new Response(null, { status: 101, webSocket: client! });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const size = typeof message === "string" ? message.length : message.byteLength;

    if (size > MAX_MESSAGE_BYTES) return this.drop(socket, MESSAGE_TOO_BIG, "Message too big");

    const attachment = attachmentOf(socket);

    if (attachment.role === "phone") {
      const host = this.provenHost();

      if (typeof message === "string") return this.drop(socket, UNSUPPORTED, "Phones send binary");

      if (!host)
        return this.drop(socket, HOST_OFFLINE, "Your computer disconnected from the relay");

      return host.send(sealEnvelope(attachment.channel, new Uint8Array(message)));
    }

    if (typeof message !== "string") {
      const envelope = attachment.proven ? openEnvelope(new Uint8Array(message)) : null;

      if (!envelope) return this.drop(socket, UNPROVEN, "Prove you own this host first");

      this.phone(envelope.channel)?.send(envelope.payload);

      return;
    }

    const control = Option.getOrNull(decodeControl(message));

    if (!attachment.proven) {
      if (control?._tag !== "proof" || !this.proves(attachment.nonce, control.signature))
        return this.drop(socket, UNPROVEN, "That signature doesn't match this host id");

      for (const earlier of this.hosts())
        if (earlier !== socket && isProven(earlier))
          this.drop(earlier, REPLACED, "This host connected again elsewhere");

      socket.serializeAttachment({ ...attachment, proven: true } satisfies HostAttachment);
      sendControl(socket, RelayControl.cases.ready.make({}));

      return;
    }

    if (control?._tag === "close") {
      const phone = this.phone(control.channel);

      if (phone) closeQuietly(phone, 1000, "Closed by your computer");
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    this.drop(socket, code === 1005 ? 1000 : code, reason);
  }

  webSocketError(socket: WebSocket) {
    this.drop(socket, 1011, "Connection error");
  }

  /** Closes a socket and lets the other side know: a host takes its phones with it. */
  private drop(socket: WebSocket, code: number, reason: string) {
    const attachment = attachmentOf(socket);
    closeQuietly(socket, code, reason);

    if (attachment.role === "phone") {
      const host = this.provenHost();

      if (host) sendControl(host, RelayControl.cases.close.make({ channel: attachment.channel }));

      return;
    }

    if (!attachment.proven || this.provenHost()) return;

    for (const phone of this.ctx.getWebSockets("phone"))
      closeQuietly(phone, HOST_OFFLINE, "Your computer disconnected from the relay");
  }

  private proves(nonce: string, signature: string) {
    const nonceBytes = decodeBase64Url(nonce);

    return nonceBytes !== null && verifyRelayChallenge(this.hostId(), nonceBytes, signature);
  }

  private hostId() {
    // SAFETY: the worker only routes to rooms by `getByName(hostId)`.
    return this.ctx.id.name!;
  }

  private hosts() {
    return this.ctx.getWebSockets("host").filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private provenHost() {
    return this.hosts().find(isProven) ?? null;
  }

  private phone(channel: number) {
    return this.ctx
      .getWebSockets(`channel:${channel}`)
      .find((socket) => socket.readyState === WebSocket.OPEN);
  }

  private unusedChannel() {
    for (;;) {
      const channel = crypto.getRandomValues(new Uint32Array(1))[0]!;

      if (this.ctx.getWebSockets(`channel:${channel}`).length === 0) return channel;
    }
  }
}
