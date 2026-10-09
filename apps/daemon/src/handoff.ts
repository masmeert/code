import { RuntimeEvent, type ProviderKind } from "@masscode/contracts";

/** Enough to carry on with; a long thread keeps its newest part. */
const MAX_CHARS = 40_000;

const MAX_MESSAGE_CHARS = 6_000;

function clip(text: string, maxChars: number) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * What a harness is told on taking a thread over: the messages it missed, oldest first,
 * with the tool calls between them, cut from the oldest end to fit. Built from the transcript
 * rather than written by a model, so it's instant and says only what happened. Null when it
 * missed nothing. `from` is the harness that answered last.
 */
export function buildHandoff({
  events,
  isFresh,
  getHarnessName,
}: {
  readonly events: ReadonlyArray<RuntimeEvent>;
  /** It has no conversation of its own on the thread, so it gets all of it. */
  readonly isFresh: boolean;
  readonly getHarnessName: (provider: ProviderKind) => string;
}) {
  const lines: Array<string> = [];
  let messages = 0;
  // Switching harness tags every earlier message with where it went, so each one says.
  let answering: ProviderKind | undefined;

  for (const event of events) {
    if (RuntimeEvent.guards["user.message"](event)) {
      answering = event.provider ?? answering;
      messages++;
      lines.push(`User: ${clip(event.text, MAX_MESSAGE_CHARS)}`);
    } else if (RuntimeEvent.guards["assistant.completed"](event) && event.text) {
      messages++;
      lines.push(
        `${answering ? getHarnessName(answering) : "Agent"}: ${clip(event.text, MAX_MESSAGE_CHARS)}`,
      );
    } else if (RuntimeEvent.guards["tool.started"](event) && !event.parentToolId) {
      lines.push(`  (${event.name}${event.summary ? `: ${clip(event.summary, 200)}` : ""})`);
    } else if (RuntimeEvent.guards.error(event)) {
      lines.push(`  (Error: ${clip(event.message, 500)})`);
    }
  }

  if (messages === 0 || answering === undefined) return null;

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

  const from = getHarnessName(answering);

  const intro = isFresh
    ? `This conversation started with ${from} in MassCode, and you're taking it over. Here it is so far, oldest first.`
    : `While you were away, ${from} carried on this conversation in MassCode. Here's what was said since your last turn, oldest first.`;

  return {
    from: answering,
    messages,
    text: `${intro} Files on disk are as it left them, so check them rather than relying on this.\n\n<conversation>\n${kept.toReversed().join("\n")}\n</conversation>\n\nThe user's next message follows.`,
  };
}
