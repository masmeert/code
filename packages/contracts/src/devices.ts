import * as Schema from "effect/Schema";

export const DevicePlatform = Schema.Literals(["ios", "android"]);

export type DevicePlatform = typeof DevicePlatform.Type;

/** An iOS simulator or Android emulator on this Mac. */
export const Device = Schema.Struct({
  /** A simulator's UDID, or an emulator's AVD name. */
  id: Schema.String,
  platform: DevicePlatform,
  name: Schema.String,
  /** Like "iOS 27.0" or "Android". */
  version: Schema.String,
  booted: Schema.Boolean,
  /** What the hub streams it by: the UDID, or a running emulator's serial; null while an emulator is off. */
  streamId: Schema.NullOr(Schema.String),
});

export type Device = typeof Device.Type;

/** Where this Mac's device hub serves simulator streams and input; the token gates all of it. */
export const DeviceHub = Schema.Struct({
  origin: Schema.String,
  token: Schema.String,
});

export type DeviceHub = typeof DeviceHub.Type;
