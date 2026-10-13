import type { PreparedVoiceTranscription, VoiceTranscriber } from "../api/voice-transcription.ts";

export const VOICE_RECORDING_LIMIT_SECONDS = 5 * 60;

export type VoiceInputPhase = "idle" | "preparing" | "recording" | "transcribing" | "error";

export interface VoiceInputState {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  /** What tapping the mic does after an error: try again, or open Settings to allow the mic. */
  readonly errorAction: "retry" | "settings" | null;
}

export function voiceInputBlocksSubmission(state: VoiceInputState): boolean {
  return (
    state.phase === "preparing" || state.phase === "recording" || state.phase === "transcribing"
  );
}

interface TextSelection {
  readonly start: number;
  readonly end: number;
}

/** The draft as dictation found it, so a transcript only lands in the draft it was spoken for. */
export interface VoiceDraftSnapshot {
  readonly ownerKey: string;
  readonly text: string;
  readonly selection: TextSelection;
}

export interface VoiceRecorderStatus {
  readonly isFinished: boolean;
  readonly hasError: boolean;
  readonly error: string | null;
  readonly url: string | null;
}

export interface VoiceRecorder {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options: { readonly forDuration: number }): void;
  stop(): Promise<void>;
}

interface VoiceInputControllerDependencies {
  readonly recorder: VoiceRecorder;
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly requestPermission: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly configureRecording: () => Promise<void>;
  readonly releaseRecording: () => Promise<void>;
  readonly deleteRecording: (uri: string) => void;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (text: string, selection: TextSelection) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
}

type TranscriptCommitResult =
  | { readonly kind: "commit"; readonly text: string; readonly selection: TextSelection }
  | { readonly kind: "stale" }
  | { readonly kind: "empty" };

function resolveTranscriptCommit(
  captured: VoiceDraftSnapshot,
  current: VoiceDraftSnapshot | null,
  transcript: string,
  locale: string,
): TranscriptCommitResult {
  if (!current || current.ownerKey !== captured.ownerKey || current.text !== captured.text) {
    return { kind: "stale" };
  }

  const replacement = transcript.trim();

  if (replacement.length === 0) return { kind: "empty" };

  const normalizedLocale = locale.replaceAll("_", "-").toLowerCase();
  const usesEnglishSpacing = normalizedLocale === "en" || normalizedLocale.startsWith("en-");
  let insertion = replacement;

  if (captured.selection.start === captured.selection.end && usesEnglishSpacing) {
    const left = captured.text[captured.selection.start - 1];
    const right = captured.text[captured.selection.start];

    const leftNeedsBoundary =
      left !== undefined &&
      /[A-Za-z0-9.!?,:;)\]}'"]/.test(left) &&
      (right === undefined || /\s/.test(right));

    const rightNeedsBoundary =
      right !== undefined &&
      /[A-Za-z0-9([{'"]/.test(right) &&
      (left === undefined || /\s/.test(left));

    insertion = `${leftNeedsBoundary ? " " : ""}${replacement}${rightNeedsBoundary ? " " : ""}`;
  }

  const start = Math.max(0, Math.min(captured.text.length, captured.selection.start));
  const end = Math.max(start, Math.min(captured.text.length, captured.selection.end));
  const cursor = start + insertion.length;

  return {
    kind: "commit",
    text: `${captured.text.slice(0, start)}${insertion}${captured.text.slice(end)}`,
    selection: { start: cursor, end: cursor },
  };
}

interface VoiceInputSession {
  abandoned: boolean;
  readonly released: Promise<void>;
  readonly release: () => void;
}

// One microphone and one transcriber: every composer's controller shares these.
let activeSession: VoiceInputSession | null = null;

let activeTranscriptionOperation: Promise<string | PreparedVoiceTranscription> | null = null;

function acquireSession(): VoiceInputSession | null {
  if (activeSession) return null;

  const { promise, resolve } = Promise.withResolvers<void>();
  const token = { abandoned: false, released: promise, release: resolve };

  activeSession = token;

  return token;
}

function releaseSession(token: VoiceInputSession | null) {
  if (token && activeSession === token) {
    activeSession = null;
    token.release();
  }
}

async function runTranscriptionOperation<Result extends string | PreparedVoiceTranscription>(
  operation: () => Promise<Result>,
): Promise<Result> {
  if (activeTranscriptionOperation) throw new Error("voice-operation-busy");

  const promise = operation();

  activeTranscriptionOperation = promise;

  try {
    return await promise;
  } finally {
    if (activeTranscriptionOperation === promise) activeTranscriptionOperation = null;
  }
}

function isBusyError(cause: unknown) {
  return cause instanceof Error && cause.message === "voice-operation-busy";
}

const BUSY_MESSAGE = "Dictation is still finishing the last recording. Try again in a moment.";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

/**
 * Records, transcribes and inserts one dictation at a time: idle → preparing → recording →
 * transcribing → idle, or error. Cancelling, leaving the app or the draft changing underneath
 * abandons the run and cleans up its recording.
 */
export class VoiceInputController {
  private readonly dependencies: VoiceInputControllerDependencies;
  private state: VoiceInputState = IDLE_STATE;
  private operationToken = 0;
  private sessionToken: VoiceInputSession | null = null;
  private transcription: PreparedVoiceTranscription | null = null;
  private transcriptionAbortController: AbortController | null = null;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private recordingUri: string | null = null;
  private readonly ownedRecordingUris = new Set<string>();
  private recordingConfigured = false;
  private finishing = false;

  constructor(dependencies: VoiceInputControllerDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;

    const initiatingDraft = this.dependencies.readDraft();

    if (!initiatingDraft) {
      this.setError("This draft is no longer open. Open it again to dictate.", "retry");

      return;
    }

    let sessionToken: VoiceInputSession | null = null;
    const operationToken = ++this.operationToken;

    this.setState({ phase: "preparing", error: null, errorAction: null });

    try {
      for (
        let previousSession = activeSession;
        previousSession?.abandoned;
        previousSession = activeSession
      ) {
        await previousSession.released;

        if (!this.isCurrent(operationToken)) return;
      }

      sessionToken = acquireSession();

      if (!sessionToken) {
        this.setError("Another draft is recording. Finish that dictation first.", "retry");

        return;
      }

      this.sessionToken = sessionToken;

      const abortController = new AbortController();

      this.transcriptionAbortController = abortController;

      const transcriber = this.dependencies.getTranscriber();

      if (!transcriber) {
        this.setError("Dictation isn't available on this iPhone or in its language.", null);

        return;
      }

      const permission = await this.dependencies.requestPermission();

      if (!this.isCurrent(operationToken)) return;

      if (!permission.granted) {
        if (permission.canAskAgain) {
          this.setError("Dictation needs the microphone. Tap the mic to allow it.", "retry");
        } else {
          this.setError(
            "Microphone access is off. Tap the mic to turn it on in Settings.",
            "settings",
          );
        }

        return;
      }

      try {
        this.transcription = await runTranscriptionOperation(() =>
          transcriber.prepare({ signal: abortController.signal }),
        );
      } catch (cause) {
        if (this.isCurrent(operationToken)) {
          this.setError(
            isBusyError(cause)
              ? BUSY_MESSAGE
              : "Couldn't get dictation ready. Check you're online for the first use, then tap the mic again.",
            "retry",
          );
        }

        return;
      }

      if (!this.isCurrent(operationToken)) return;

      await this.dependencies.configureRecording();
      this.recordingConfigured = true;

      if (!this.isCurrent(operationToken)) return;

      await this.dependencies.recorder.prepareToRecordAsync();

      if (!this.isCurrent(operationToken)) return;

      this.recordingUri = this.dependencies.recorder.uri;
      this.rememberRecordingUri(this.recordingUri);

      const capturedDraft = this.dependencies.readDraft();

      if (!capturedDraft || capturedDraft.ownerKey !== initiatingDraft.ownerKey) {
        this.setError("This draft is no longer open. Open it again to dictate.", "retry");

        return;
      }

      this.capturedDraft = capturedDraft;
      this.dependencies.recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch {
      if (this.isCurrent(operationToken)) {
        this.setError("Couldn't start recording. Tap the mic to try again.", "retry");
      }
    } finally {
      if (sessionToken && this.sessionToken === sessionToken) {
        if (this.isCurrent(operationToken) && this.state.phase === "error") {
          await this.releaseResources();
        } else if (!this.isCurrent(operationToken) && !this.finishing) {
          await this.releaseResources();
        }
      }
    }
  }

  stop(): Promise<void> {
    if (this.state.phase !== "recording") return Promise.resolve();

    return this.finishRecording(false, null);
  }

  cancel() {
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        this.setState(IDLE_STATE);

        return;
      case "preparing":
      case "transcribing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);

        return;
      case "recording":
        void this.discardRecording(null);
    }
  }

  interruptRecording(
    message = "Recording was interrupted. Tap the mic to start again.",
    completedUri: string | null = null,
  ): Promise<void> | undefined {
    if (this.state.phase !== "recording") return;

    this.rememberRecordingUri(completedUri);
    this.recordingUri = completedUri ?? this.recordingUri;

    return this.discardRecording(message);
  }

  appMovedToBackground(): Promise<void> | undefined {
    if (this.state.phase === "preparing") {
      this.invalidateOperation();
      this.setError(
        "Dictation stopped when you left the app. Tap the mic to start again.",
        "retry",
      );

      return;
    }

    return this.interruptRecording();
  }

  handleRecorderStatus(status: VoiceRecorderStatus): Promise<void> | undefined {
    if (this.state.phase !== "recording") return;

    if (status.hasError) {
      return this.interruptRecording(
        status.error ?? "Recording was interrupted. Tap the mic to start again.",
        status.url,
      );
    }

    if (status.isFinished) {
      if (!status.url) return this.interruptRecording();

      return this.finishRecording(true, status.url);
    }
  }

  dispose() {
    if (this.state.phase === "recording") {
      void this.discardRecording(null);

      return;
    }

    if (this.state.phase === "preparing" || this.state.phase === "transcribing") {
      this.invalidateOperation();
      this.setState(IDLE_STATE);
    }
  }

  private async finishRecording(alreadyStopped: boolean, completedUri: string | null) {
    if (this.finishing || this.state.phase !== "recording") return;

    this.finishing = true;

    const operationToken = this.operationToken;

    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      if (!alreadyStopped) await this.dependencies.recorder.stop();

      await this.releaseAudioSession();
      this.recordingUri = completedUri ?? this.dependencies.recorder.uri ?? this.recordingUri;
      this.rememberRecordingUri(this.recordingUri);

      if (!this.isCurrent(operationToken)) return;

      if (
        !this.recordingUri ||
        !this.transcription ||
        !this.transcriptionAbortController ||
        !this.capturedDraft
      ) {
        this.setError("Couldn't finish recording. Tap the mic to try again.", "retry");

        return;
      }

      const recordingUri = this.recordingUri;
      const transcription = this.transcription;
      const signal = this.transcriptionAbortController.signal;
      const capturedDraft = this.capturedDraft;
      let transcript: string;

      try {
        transcript = await runTranscriptionOperation(() =>
          transcription.transcribe(recordingUri, { signal }),
        );
      } catch (cause) {
        if (this.isCurrent(operationToken)) {
          this.setError(
            isBusyError(cause)
              ? BUSY_MESSAGE
              : "Couldn't turn that recording into text. Tap the mic to try again.",
            "retry",
          );
        }

        return;
      }

      if (!this.isCurrent(operationToken)) return;

      const result = resolveTranscriptCommit(
        capturedDraft,
        this.dependencies.readDraft(),
        transcript,
        transcription.locale,
      );

      if (result.kind === "stale") {
        this.setError("The draft changed while you dictated, so the text wasn't added.", "retry");

        return;
      }

      if (result.kind === "empty") {
        this.setError("No speech was heard. Tap the mic and try again.", "retry");

        return;
      }

      this.dependencies.commitDraft(result.text, result.selection);
      this.setState(IDLE_STATE);
    } catch {
      if (this.isCurrent(operationToken)) {
        this.setError("Couldn't finish recording. Tap the mic to try again.", "retry");
      }
    } finally {
      this.finishing = false;
      await this.releaseResources();
    }
  }

  private async discardRecording(error: string | null) {
    this.invalidateOperation();
    this.setState(error ? { phase: "error", error, errorAction: "retry" } : IDLE_STATE);

    try {
      await this.dependencies.recorder.stop();
    } catch {
      // The recorder may already have stopped on its own.
    } finally {
      await this.releaseResources();
    }
  }

  private async releaseResources() {
    this.rememberRecordingUri(this.recordingUri);

    try {
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } catch {
      // A released native recorder can throw on access; its file was remembered when it prepared.
    }

    this.recordingUri = null;

    for (const uri of this.ownedRecordingUris) {
      try {
        this.dependencies.deleteRecording(uri);
      } catch {
        // The cache may already have removed a failed or interrupted recording.
      }
    }

    this.ownedRecordingUris.clear();
    await this.releaseAudioSession();
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.transcription = null;
    this.transcriptionAbortController = null;
  }

  private rememberRecordingUri(uri: string | null) {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession() {
    if (!this.recordingConfigured) return;

    try {
      await this.dependencies.releaseRecording();
      this.recordingConfigured = false;
    } catch {
      // Final cleanup retries if the prompt release before transcription fails.
    }
  }

  private invalidateOperation() {
    this.operationToken += 1;

    if (this.sessionToken) this.sessionToken.abandoned = true;

    this.transcriptionAbortController?.abort();
  }

  private isCurrent(operationToken: number) {
    return operationToken === this.operationToken;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]) {
    this.setState({ phase: "error", error, errorAction });
  }

  private setState(state: VoiceInputState) {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}
