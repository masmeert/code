import * as Schema from "effect/Schema";

/** A process listening on TCP ports that a thread's agent or terminal started, dev servers mostly. */
export const Service = Schema.Struct({
  threadId: Schema.String,
  pid: Schema.Number,
  ports: Schema.Array(Schema.Number),
  /** The executable's name, such as `node`. */
  name: Schema.String,
  command: Schema.String,
});

export type Service = typeof Service.Type;
