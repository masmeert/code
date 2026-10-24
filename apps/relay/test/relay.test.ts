import { afterAll, beforeAll, expect, test } from "bun:test";
import { HOST_OFFLINE, RelayControl } from "@masscode/contracts";
import {
  decodeBase64Url,
  generateHostSecret,
  hostIdFromSecret,
  openEnvelope,
  sealEnvelope,
  signRelayChallenge,
} from "@masscode/secure-channel";
import * as Schema from "effect/Schema";
import { startLocalRelay } from "./local-relay.ts";

const decodeControl = Schema.decodeUnknownSync(Schema.fromJsonString(RelayControl));

let relay: Awaited<ReturnType<typeof startLocalRelay>>;

let relayUrl: string;

beforeAll(async () => {
  relay = await startLocalRelay();
  relayUrl = relay.url;
}, 60_000);

afterAll(() => relay?.stop());

/** Every message a socket gets, in order, awaitable one at a time. */
function openSocket(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  const received: Array<string | Uint8Array> = [];
  const waiting: Array<(message: string | Uint8Array) => void> = [];

  socket.addEventListener("message", (event) => {
    const message = typeof event.data === "string" ? event.data : new Uint8Array(event.data);
    const resolve = waiting.shift();

    if (resolve) resolve(message);
    else received.push(message);
  });

  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  );

  function next() {
    return received.length > 0
      ? Promise.resolve(received.shift()!)
      : new Promise<string | Uint8Array>((resolve) => waiting.push(resolve));
  }

  return {
    socket,
    closed,
    opened: new Promise<void>((resolve) => socket.addEventListener("open", () => resolve())),
    next,
    async nextBinary() {
      const message = await next();

      if (typeof message === "string") throw new Error(`Expected binary, got ${message}`);

      return message;
    },
  };
}

async function connectHost(hostSecret = generateHostSecret()) {
  const host = openSocket(`${relayUrl}/hosts/${hostIdFromSecret(hostSecret)}?role=host`);
  const challenge = decodeControl(await host.next());

  if (!RelayControl.guards.challenge(challenge)) throw new Error("Expected a challenge");

  host.socket.send(
    JSON.stringify(
      RelayControl.cases.proof.make({
        signature: signRelayChallenge(hostSecret, decodeBase64Url(challenge.nonce)!),
      }),
    ),
  );

  expect(RelayControl.guards.ready(decodeControl(await host.next()))).toBe(true);

  return { ...host, hostId: hostIdFromSecret(hostSecret), hostSecret };
}

async function connectPhone(hostId: string, host: Awaited<ReturnType<typeof connectHost>>) {
  const phone = openSocket(`${relayUrl}/hosts/${hostId}?role=phone`);
  await phone.opened;
  const opened = decodeControl(await host.next());

  if (!RelayControl.guards.open(opened)) throw new Error("Expected an open");

  return { ...phone, channel: opened.channel };
}

test("a phone's bytes reach the host in an envelope, and the host's reply reaches the phone", async () => {
  const host = await connectHost();
  const phone = await connectPhone(host.hostId, host);

  phone.socket.send(new Uint8Array([1, 2, 3]));
  expect(openEnvelope(await host.nextBinary())).toEqual({
    channel: phone.channel,
    payload: new Uint8Array([1, 2, 3]),
  });

  host.socket.send(sealEnvelope(phone.channel, new Uint8Array([4, 5])));
  expect(await phone.next()).toEqual(new Uint8Array([4, 5]));

  host.socket.close();
  phone.socket.close();
});

test("two phones get their own channels", async () => {
  const host = await connectHost();
  const first = await connectPhone(host.hostId, host);
  const second = await connectPhone(host.hostId, host);

  expect(first.channel).not.toBe(second.channel);

  host.socket.send(sealEnvelope(second.channel, new Uint8Array([9])));
  expect(await second.next()).toEqual(new Uint8Array([9]));

  host.socket.close();
});

test("a phone is turned away while its host isn't connected", async () => {
  const phone = openSocket(
    `${relayUrl}/hosts/${hostIdFromSecret(generateHostSecret())}?role=phone`,
  );

  expect((await phone.closed).code).toBe(HOST_OFFLINE);
});

test("phones are dropped when their host disconnects", async () => {
  const host = await connectHost();
  const phone = await connectPhone(host.hostId, host);

  host.socket.close();

  expect((await phone.closed).code).toBe(HOST_OFFLINE);
});

test("the host hears when a phone disconnects", async () => {
  const host = await connectHost();
  const phone = await connectPhone(host.hostId, host);

  phone.socket.close();

  expect(decodeControl(await host.next())).toEqual(
    RelayControl.cases.close.make({ channel: phone.channel }),
  );

  host.socket.close();
});

test("a host that can't sign for its id is refused", async () => {
  const hostId = hostIdFromSecret(generateHostSecret());
  const impostor = openSocket(`${relayUrl}/hosts/${hostId}?role=host`);
  const challenge = decodeControl(await impostor.next());

  if (!RelayControl.guards.challenge(challenge)) throw new Error("Expected a challenge");

  impostor.socket.send(
    JSON.stringify(
      RelayControl.cases.proof.make({
        signature: signRelayChallenge(generateHostSecret(), decodeBase64Url(challenge.nonce)!),
      }),
    ),
  );

  expect((await impostor.closed).code).toBe(4401);
});

test("a host reconnecting replaces its earlier socket", async () => {
  const hostSecret = generateHostSecret();
  const earlier = await connectHost(hostSecret);
  const later = await connectHost(hostSecret);

  expect((await earlier.closed).code).toBe(4409);

  const phone = await connectPhone(later.hostId, later);
  phone.socket.send(new Uint8Array([7]));
  expect(openEnvelope(await later.nextBinary())?.payload).toEqual(new Uint8Array([7]));

  later.socket.close();
});

test("a malformed host id is refused before upgrading", async () => {
  const response = await fetch(`${relayUrl.replace(/^ws/, "http")}/hosts/nope?role=phone`, {
    headers: { upgrade: "websocket" },
  });

  expect(response.status).toBe(404);
});

test("a message larger than a Noise message is refused", async () => {
  const host = await connectHost();
  const phone = await connectPhone(host.hostId, host);

  phone.socket.send(new Uint8Array(200 * 1024));

  expect((await phone.closed).code).toBe(1009);

  host.socket.close();
});

test("the relay answers pings without waking anything", async () => {
  const host = await connectHost();

  host.socket.send("ping");
  expect(await host.next()).toBe("pong");

  host.socket.close();
});
