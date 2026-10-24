import { RelayHello, RelayWelcome, PROTOCOL_VERSION } from "@masscode/contracts";
import { connectThroughRelay, decodeBase64Url, keyPairFromSecret } from "@masscode/secure-channel";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** How a phone reaches a host through the relay: where it is, the host's key, and this phone's. */
export interface RelayRoute {
  readonly relayUrl: string;
  readonly hostId: string;
  /** This phone's X25519 secret for that host, base64url. */
  readonly secretKey: string;
}

/** What partysocket is given as a URL for the relay route: the socket looks the route up by host id. */
export const RELAY_URL_PREFIX = "masscode-relay://";

const decodeWelcome = Schema.decodeUnknownOption(Schema.fromJsonString(RelayWelcome));

/** A close the phone gives itself when the host answers with something this version can't read. */
const PROTOCOL_ERROR = 1002;

function eventWith<A extends object>(type: string, fields: A) {
  return Object.assign(new Event(type), fields);
}

/**
 * The relay route dressed as a WebSocket, so partysocket retries it like any other: it opens once
 * the host accepts this phone, and closes with the host's code (`UNPAIRED`, `PROTOCOL_MISMATCH`)
 * when it doesn't.
 */
export class RelaySocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType = "arraybuffer";
  readyState = 0;
  private readonly connection: ReturnType<typeof connectThroughRelay>;

  constructor(route: RelayRoute) {
    super();
    this.url = `${RELAY_URL_PREFIX}${route.hostId}`;

    const secretKey = decodeBase64Url(route.secretKey);

    if (secretKey?.length !== 32) throw new Error("Malformed phone key; pair again");

    this.connection = connectThroughRelay({
      relayUrl: route.relayUrl,
      hostId: route.hostId,
      keyPair: keyPairFromSecret(secretKey),
      hello: JSON.stringify(RelayHello.cases.connect.make({ protocol: PROTOCOL_VERSION })),
      onText: (text) => this.dispatchEvent(eventWith("message", { data: text })),
      onClose: (code, reason) => {
        this.readyState = this.CLOSED;
        this.dispatchEvent(eventWith("close", { code, reason, wasClean: code === 1000 }));
      },
    });

    this.connection.welcome.then(
      (text) => {
        const welcome = Option.getOrNull(decodeWelcome(text));

        if (welcome && RelayWelcome.guards.refused(welcome))
          return this.connection.close(welcome.code, welcome.reason);

        if (!welcome || !RelayWelcome.guards.accepted(welcome))
          return this.connection.close(PROTOCOL_ERROR, "Unexpected answer from your computer");

        this.readyState = this.OPEN;
        this.dispatchEvent(new Event("open"));
      },
      () => {},
    );
  }

  send(text: string) {
    this.connection.send(text);
  }

  close(code?: number, reason?: string) {
    if (this.readyState === this.CLOSED) return;

    this.readyState = this.CLOSING;
    this.connection.close(code, reason);
  }
}
