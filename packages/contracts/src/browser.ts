import * as Schema from "effect/Schema";

export const BROWSER_PARTITION = "persist:masscode-browser";

/** Each remote host browses through its own SSH tunnel, so its `localhost` is the host's. */
export function browserPartition(host: string | null) {
  return host === null ? BROWSER_PARTITION : `${BROWSER_PARTITION}:${host}`;
}

export const BrowserAction = Schema.TaggedUnion({
  navigate: { url: Schema.String },
  status: {},
  snapshot: {},
  click: { target: Schema.String },
  type: {
    target: Schema.String,
    text: Schema.String,
    submit: Schema.Boolean,
  },
  press: { key: Schema.String },
  evaluate: { expression: Schema.String },
  console: {},
});
export type BrowserAction = typeof BrowserAction.Type;

export const BrowserResult = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  text: Schema.String,
  screenshot: Schema.NullOr(Schema.String),
});
export type BrowserResult = typeof BrowserResult.Type;
