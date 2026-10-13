import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";

/** Cancellation is cooperative: settle only after the underlying work has stopped. */
export interface VoiceTranscriptionOptions {
  readonly signal: AbortSignal;
}

/** Binds a recording to its selected implementation and resolved locale. */
export interface PreparedVoiceTranscription {
  readonly locale: string;
  readonly transcribe: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
}

export interface VoiceTranscriber {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceTranscription>;
}

type VoiceTranscriptionErrorCode =
  | "unavailable"
  | "preparation-failed"
  | "transcription-failed"
  | "cancelled";

export class VoiceTranscriptionError extends Error {
  readonly code: VoiceTranscriptionErrorCode;

  constructor(code: VoiceTranscriptionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceTranscriptionError";
    this.code = code;
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
  }
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (cause instanceof VoiceTranscriptionError) return cause;

  return new VoiceTranscriptionError(code, message, { cause });
}

/** Apple's on-device SpeechAnalyzer (iOS 26), or null where it can't transcribe the device language. */
export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  if (!AppleTranscription.isAvailable(locale)) return null;

  return { prepare: (options) => prepareVoiceTranscription(locale, options) };
}

async function prepareVoiceTranscription(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfAborted(signal);

  if (!AppleTranscription.isAvailable(locale)) {
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice transcription requires a supported device with iOS 26 or later.",
    );
  }

  try {
    // Downloads the language's speech model the first time.
    await AppleTranscription.prepare(locale);
    throwIfAborted(signal);

    return {
      locale,
      transcribe: (uri, options) => transcribeVoiceRecording(uri, locale, options),
    };
  } catch (cause) {
    throwIfAborted(signal);

    throw wrapError(
      "preparation-failed",
      "Voice transcription could not prepare this language.",
      cause,
    );
  }
}

async function transcribeVoiceRecording(
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfAborted(signal);

    const audio = await new File(uri).arrayBuffer();

    throwIfAborted(signal);

    const result = await AppleTranscription.transcribe(audio, locale);

    throwIfAborted(signal);

    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  } catch (cause) {
    throwIfAborted(signal);

    throw wrapError("transcription-failed", "Voice transcription failed.", cause);
  }
}
