import {
  ClientCommand,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  RelayHello,
  RelayWelcome,
  RuntimeEvent,
  ServerFrame,
  UNPAIRED,
} from "@masscode/contracts";
import { connectThroughRelay, generateKeyPair, type KeyPair } from "@masscode/secure-channel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLocalRelay } from "../../relay/test/local-relay.ts";
import { startDaemon, type Daemon } from "./replay/daemon.ts";

const decodeWelcome = Schema.decodeUnknownSync(Schema.fromJsonString(RelayWelcome));

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ServerFrame));

let relay: Awaited<ReturnType<typeof startLocalRelay>>;

let daemon: Daemon | null = null;

beforeAll(async () => {
  relay = await startLocalRelay();
  process.env.MASSCODE_RELAY_URL = relay.url;
}, 60_000);

afterAll(() => relay?.stop());

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

/** A daemon with phone access on, once it's reachable through the relay. */
async function startReachableDaemon() {
  daemon = await startDaemon();

  const settings = await Effect.runPromise(
    Effect.scoped(Effect.map(daemon.manager.subscribe, ({ settings }) => settings)),
  );

  await daemon.dispatch(
    ClientCommand.cases["settings.update"].make({ settings: { ...settings, remoteAccess: true } }),
  );
  await daemon.listen();
  await daemon.waitFor(
    (event) =>
      RuntimeEvent.guards["phoneAccess.updated"](event) && event.access.relay === "connected",
    10_000,
  );

  return daemon;
}

function startPairing(host: Daemon) {
  return Effect.runPromise(host.manager.phones.startPairing());
}

/** A phone's session through the relay: what it was answered, then each frame as it comes. */
function openPhone(hostId: string, keyPair: KeyPair, hello: RelayHello) {
  const frames: ServerFrame[] = [];
  const waiting = new Set<() => void>();

  const closed = Promise.withResolvers<{ code: number; reason: string }>();

  const connection = connectThroughRelay({
    relayUrl: relay.url,
    hostId,
    keyPair,
    hello: JSON.stringify(hello),
    onText(text) {
      frames.push(decodeFrame(text));

      for (const wake of waiting) wake();
    },
    onClose: (code, reason) => closed.resolve({ code, reason }),
  });

  return {
    connection,
    closed: closed.promise,
    welcome: connection.welcome.then(decodeWelcome),
    send: (command: ClientCommand) => connection.send(JSON.stringify(command)),
    nextFrame<A extends ServerFrame>(test: (frame: ServerFrame) => frame is A) {
      return new Promise<A>((resolve) => {
        function check() {
          const found = frames.find(test);

          if (!found) return;

          waiting.delete(check);
          resolve(found);
        }

        waiting.add(check);
        check();
      });
    },
  };
}

async function pairPhone(host: Daemon, keyPair: KeyPair) {
  const offer = await startPairing(host);

  const phone = openPhone(
    offer.hostId,
    keyPair,
    RelayHello.cases.pair.make({
      protocol: PROTOCOL_VERSION,
      request: { code: offer.code, name: "Test iPhone", platform: "ios" },
    }),
  );

  return { offer, welcome: await phone.welcome };
}

test("a pairing offer works without Tailscale, naming the host's key and relay", async () => {
  const host = await startReachableDaemon();
  const offer = await startPairing(host);

  expect(offer.hostId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(offer.relayUrl).toBe(relay.url);
  expect(offer.url).toContain(`id=${offer.hostId}`);
}, 15_000);

test("a phone pairs through the relay with the code, then connects and gets the shell", async () => {
  const host = await startReachableDaemon();
  const keyPair = generateKeyPair();
  const { offer, welcome } = await pairPhone(host, keyPair);

  if (!RelayWelcome.guards.paired(welcome)) throw new Error(`Expected paired, got ${welcome._tag}`);

  expect(welcome.grant.hostId).toBe(offer.hostId);

  const phone = openPhone(
    offer.hostId,
    keyPair,
    RelayHello.cases.connect.make({ protocol: PROTOCOL_VERSION }),
  );

  expect(RelayWelcome.guards.accepted(await phone.welcome)).toBe(true);
  expect((await phone.nextFrame(ServerFrame.guards.shell)).protocol).toBe(PROTOCOL_VERSION);

  phone.connection.close();
}, 15_000);

test("a wrong code is refused, and the phone stays unknown", async () => {
  const host = await startReachableDaemon();
  const offer = await startPairing(host);
  const keyPair = generateKeyPair();

  const pairing = openPhone(
    offer.hostId,
    keyPair,
    RelayHello.cases.pair.make({
      protocol: PROTOCOL_VERSION,
      request: {
        code: offer.code === "000000" ? "111111" : "000000",
        name: "Test iPhone",
        platform: "ios",
      },
    }),
  );

  expect(RelayWelcome.guards.refused(await pairing.welcome)).toBe(true);

  const phone = openPhone(
    offer.hostId,
    keyPair,
    RelayHello.cases.connect.make({ protocol: PROTOCOL_VERSION }),
  );

  const welcome = await phone.welcome;

  expect(RelayWelcome.guards.refused(welcome) && welcome.code).toBe(UNPAIRED);
}, 15_000);

test("a phone speaking another protocol is turned away and told why", async () => {
  const host = await startReachableDaemon();
  const keyPair = generateKeyPair();
  const { offer } = await pairPhone(host, keyPair);

  const phone = openPhone(
    offer.hostId,
    keyPair,
    RelayHello.cases.connect.make({ protocol: PROTOCOL_VERSION + 1 }),
  );

  const welcome = await phone.welcome;

  expect(RelayWelcome.guards.refused(welcome) && welcome.code).toBe(PROTOCOL_MISMATCH);
}, 15_000);

test("unpairing a phone ends its relay session with UNPAIRED", async () => {
  const host = await startReachableDaemon();
  const keyPair = generateKeyPair();
  const { offer, welcome } = await pairPhone(host, keyPair);

  if (!RelayWelcome.guards.paired(welcome)) throw new Error("Expected paired");

  const phone = openPhone(
    offer.hostId,
    keyPair,
    RelayHello.cases.connect.make({ protocol: PROTOCOL_VERSION }),
  );

  await phone.nextFrame(ServerFrame.guards.shell);

  await host.dispatch(ClientCommand.cases["phone.unpair"].make({ phoneId: welcome.grant.phoneId }));

  expect((await phone.closed).code).toBe(UNPAIRED);
}, 15_000);

test("large frames cross the relay both ways", async () => {
  const host = await startReachableDaemon();
  const keyPair = generateKeyPair();
  const { offer } = await pairPhone(host, keyPair);

  const phone = openPhone(
    offer.hostId,
    keyPair,
    RelayHello.cases.connect.make({ protocol: PROTOCOL_VERSION }),
  );

  await phone.nextFrame(ServerFrame.guards.shell);

  const folder = tmpdir();
  const image = crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024));
  writeFileSync(join(folder, "relay-test.png"), image);

  phone.send(
    ClientCommand.cases["image.sign"].make({
      path: "relay-test.png",
      cwd: folder,
      requestId: "sign",
    }),
  );

  const signed = await phone.nextFrame(
    (frame): frame is Extract<ServerFrame, { _tag: "image.signed" }> =>
      ServerFrame.guards["image.signed"](frame) && frame.requestId === "sign",
  );

  phone.send(ClientCommand.cases["asset.read"].make({ url: signed.url!, requestId: "read" }));

  const read = await phone.nextFrame(
    (frame): frame is Extract<ServerFrame, { _tag: "asset.data" }> =>
      ServerFrame.guards["asset.data"](frame) && frame.requestId === "read",
  );

  expect(read.mediaType).toBe("image/png");
  expect(Buffer.from(read.data!, "base64").equals(Buffer.from(image))).toBe(true);

  phone.send(
    ClientCommand.cases.search.make({
      query: `relay${" ".repeat(5 * 1024 * 1024)}`,
      requestId: "search",
    }),
  );
  await phone.nextFrame(
    (frame): frame is Extract<ServerFrame, { _tag: "search.results" }> =>
      ServerFrame.guards["search.results"](frame) && frame.requestId === "search",
  );

  phone.connection.close();
}, 20_000);

test("turning phone access off disconnects from the relay", async () => {
  const host = await startReachableDaemon();

  const settings = await Effect.runPromise(
    Effect.scoped(Effect.map(host.manager.subscribe, ({ settings }) => settings)),
  );

  await host.dispatch(
    ClientCommand.cases["settings.update"].make({ settings: { ...settings, remoteAccess: false } }),
  );

  await host.waitFor(
    (event) => RuntimeEvent.guards["phoneAccess.updated"](event) && event.access.relay === "off",
  );
}, 15_000);
