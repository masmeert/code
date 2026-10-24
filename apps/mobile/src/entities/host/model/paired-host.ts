import * as Schema from "effect/Schema";

/** A host this phone paired with: how to reach its daemon, and the credentials it gave this phone. */
export const PairedHost = Schema.Struct({
  /** This phone's id on that host. */
  id: Schema.String,
  name: Schema.String,
  /** Its Tailscale address when it paired; null when it paired without Tailscale. */
  address: Schema.optional(Schema.NullOr(Schema.String)),
  /** Its MagicDNS name, which keeps working when the address changes; absent without MagicDNS. */
  dnsName: Schema.optional(Schema.NullOr(Schema.String)),
  port: Schema.optional(Schema.Number),
  /** What this phone connects directly with. */
  token: Schema.String,
  /**
   * How this phone reaches the host from anywhere, with the key it proves itself by; the
   * keychain keeps it secret. Absent for pairings from before the relay.
   */
  relay: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ relayUrl: Schema.String, hostId: Schema.String, secretKey: Schema.String }),
    ),
  ),
  /** Which host it is, wherever it listens; absent for pairings from before hosts said. */
  dataId: Schema.optional(Schema.String),
  /** Turned off on this phone: kept paired, but not connected to. Absent counts as on. */
  enabled: Schema.optional(Schema.Boolean),
});

export type PairedHost = typeof PairedHost.Type;
