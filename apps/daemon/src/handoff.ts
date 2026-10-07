import { peerOf, RuntimeEvent, type ProviderKind } from "@apcode/contracts";

/** Enough to carry on with; a long thread keeps its newest part. */
const MAX_CHARS = 40_000;
const MAX_MESSAGE_CHARS = 6_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * What harness `to` is told on taking a thread over: the messages it missed, oldest first,
 * with the tool calls between them, cut from the oldest end to fit. Built from the transcript
 * rather than written by a model, so it's instant and says only what happened. Null when it
 * missed nothing.
 */
export function handoffText({
  events,
  to,
  fresh,
  names,
}: {
  readonly events: ReadonlyArray<RuntimeEvent>;
  readonly to: ProviderKind;
  /** It has no conversation of its own on the thread, so it gets all of it. */
  readonly fresh: boolean;
  readonly names: (provider: ProviderKind) => string;
}) {
  const lines: Array<string> = [];
  let messages = 0;
  // Messages from before threads could switch harness don't say; those went to the other one.
  let answering = peerOf(to);
  for (const event of events) {
    if (RuntimeEvent.guards["user.message"](event)) {
      answering = event.provider ?? answering;
      messages++;
      lines.push(`User: ${clip(event.text, MAX_MESSAGE_CHARS)}`);
    } else if (RuntimeEvent.guards["assistant.completed"](event) && event.text) {
      messages++;
      lines.push(`${names(answering)}: ${clip(event.text, MAX_MESSAGE_CHARS)}`);
    } else if (RuntimeEvent.guards["tool.started"](event) && !event.parentToolId)
      lines.push(`  (${event.name}${event.summary ? `: ${clip(event.summary, 200)}` : ""})`);
    else if (RuntimeEvent.guards.error(event)) lines.push(`  (Error: ${clip(event.message, 500)})`);
  }
  if (messages === 0) return null;

  const kept: Array<string> = [];
  let size = 0;
  for (const line of lines.toReversed()) {
    if (size + line.length > MAX_CHARS) {
      kept.push("(Earlier messages are left out.)");
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  const from = names(peerOf(to));
  const intro = fresh
    ? `This conversation started with ${from} in APCode, and you're taking it over. Here it is so far, oldest first.`
    : `While you were away, ${from} carried on this conversation in APCode. Here's what was said since your last turn, oldest first.`;
  return {
    messages,
    text: `${intro} Files on disk are as it left them, so check them rather than relying on this.\n\n<conversation>\n${kept.toReversed().join("\n")}\n</conversation>\n\nThe user's next message follows.`,
  };
}
