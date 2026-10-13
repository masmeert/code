import * as Schema from "effect/Schema";

/** A host this phone paired with: where its daemon listens, and the token it gave this phone. */
export const PairedHost = Schema.Struct({
  /** This phone's id on that host. */
  id: Schema.String,
  name: Schema.String,
  /** Its Tailscale address when it paired. */
  address: Schema.String,
  /** Its MagicDNS name, which keeps working when the address changes; absent without MagicDNS. */
  dnsName: Schema.optional(Schema.NullOr(Schema.String)),
  port: Schema.Number,
  token: Schema.String,
  /** Which host it is, wherever it listens; absent for pairings from before hosts said. */
  dataId: Schema.optional(Schema.String),
  /** Turned off on this phone: kept paired, but not connected to. Absent counts as on. */
  enabled: Schema.optional(Schema.Boolean),
});

export type PairedHost = typeof PairedHost.Type;
