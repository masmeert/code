import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useId, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceRecorder,
} from "./controller.ts";
import { getLocalVoiceTranscriber } from "./transcription.ts";

export const VOICE_WAVEFORM_SAMPLE_COUNT = 64;

const VOICE_NOISE_FLOOR_DECIBELS = -60;

const VOICE_NOISE_FLOOR_AMPLITUDE = 10 ** (VOICE_NOISE_FLOOR_DECIBELS / 20);

/** Converts measured decibels to compressed amplitude, reserving full height for 0 dB. */
function normalizeVoiceInputDecibels(decibels: number | undefined) {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;

  if (decibels <= VOICE_NOISE_FLOOR_DECIBELS) return 0;

  if (decibels >= 0) return 1;

  const amplitude = 10 ** (decibels / 20);

  return Math.sqrt((amplitude - VOICE_NOISE_FLOOR_AMPLITUDE) / (1 - VOICE_NOISE_FLOOR_AMPLITUDE));
}

type NativeVoiceRecorder = InstanceType<typeof AudioModule.AudioRecorder>;

interface LazyVoiceRecorder extends VoiceRecorder {
  /** Status of the native recorder, or null before a recording has prepared one. */
  getStatus(): ReturnType<NativeVoiceRecorder["getStatus"]> | null;
  /**
   * Releases the native recorder after its pending prepare and stop calls settle.
   * A later recording creates a new one, so replayed effects keep working.
   */
  release(): void;
}

/**
 * Creates expo-audio's native `AudioRecorder` when a recording first prepares, instead of on
 * composer render. Construction blocks the JS thread for tens of milliseconds on a cold composer,
 * and most composer mounts never record.
 */
function createLazyVoiceRecorder(onStatus: (status: RecordingStatus) => void): LazyVoiceRecorder {
  let recorder: NativeVoiceRecorder | null = null;
  let subscription: { remove(): void } | null = null;
  // A released recorder still answers `uri` so the controller can delete its file.
  let retired: NativeVoiceRecorder | null = null;
  let retiredUri: string | null = null;
  let pending: Promise<void> = Promise.resolve();

  function track(promise: Promise<void>) {
    pending = Promise.allSettled([pending, promise]).then(() => undefined);

    return promise;
  }

  return {
    get uri() {
      if (recorder) return recorder.uri;

      return retired ? retired.uri : retiredUri;
    },
    prepareToRecordAsync() {
      if (!recorder) {
        recorder = new AudioModule.AudioRecorder({
          // The native constructor takes the platform's options flattened, as `useAudioRecorder`
          // builds them.
          extension: RecordingPresets.HIGH_QUALITY.extension,
          sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
          numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
          bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
          isMeteringEnabled: true,
          ...RecordingPresets.HIGH_QUALITY.ios,
        });
        subscription = recorder.addListener("recordingStatusUpdate", onStatus);
      }

      return track(recorder.prepareToRecordAsync());
    },
    record(options) {
      if (!recorder) throw new Error("Voice recorder is not prepared.");

      recorder.record(options);
    },
    stop() {
      return recorder ? track(recorder.stop()) : Promise.resolve();
    },
    getStatus() {
      return recorder ? recorder.getStatus() : null;
    },
    release() {
      const released = recorder;

      if (!released) return;

      recorder = null;
      subscription?.remove();
      subscription = null;
      retired = released;

      void pending.then(() => {
        if (retired === released) {
          retiredUri = released.uri;
          retired = null;
        }

        released.release();
      });
    },
  };
}

async function releaseVoiceRecordingAudio() {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its category changes.
    // Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio() {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }

    throw error;
  }
}

/** What the composer shows for dictation: which actions flank the toolbar, and its status. */
export interface VoiceComposerPresentation {
  readonly leadingAction: "cancel" | null;
  readonly trailingAction: "mic" | "confirm";
  readonly showsSend: boolean;
  readonly statusKind: "active" | "error" | null;
  readonly statusLabel: string | null;
  readonly confirmationEnabled: boolean;
}

function resolveVoiceComposerPresentation(
  state: VoiceInputState,
  elapsedSeconds: number,
): VoiceComposerPresentation {
  switch (state.phase) {
    case "idle":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: null,
        statusLabel: null,
        confirmationEnabled: false,
      };
    case "error":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: "error",
        statusLabel: state.error,
        confirmationEnabled: false,
      };
    case "preparing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Preparing",
        confirmationEnabled: false,
      };
    case "recording":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: `Recording ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`,
        confirmationEnabled: true,
      };
    case "transcribing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Transcribing",
        confirmationEnabled: false,
      };
  }
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

/** The draft a composer dictates into. */
export interface VoiceInputTarget {
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => void;
}

/**
 * Dictation into one composer's draft: records with the mic, samples its level for the waveform,
 * and transcribes on the device when stopped.
 */
export function useVoiceInput(target: VoiceInputTarget) {
  const latestTarget = useRef(target);

  latestTarget.current = target;

  const [state, setState] = useState(IDLE_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // A synchronous native call, so asked once rather than on every keystroke's render.
  const [isAvailable] = useState(() => getLocalVoiceTranscriber() !== null);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);

  const runtimeRef = useRef<{ controller: VoiceInputController; recorder: LazyVoiceRecorder }>(
    null,
  );

  if (!runtimeRef.current) {
    const recorder = createLazyVoiceRecorder((status) => {
      void runtimeRef.current?.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    });

    runtimeRef.current = {
      recorder,
      controller: new VoiceInputController({
        recorder,
        getTranscriber: getLocalVoiceTranscriber,
        requestPermission: async () => {
          const permission = await requestRecordingPermissionsAsync();

          return { granted: permission.granted, canAskAgain: permission.canAskAgain };
        },
        configureRecording: configureVoiceRecordingAudio,
        releaseRecording: releaseVoiceRecordingAudio,
        deleteRecording: (uri) => new File(uri).delete(),
        readDraft: () => latestTarget.current.readDraft(),
        commitDraft: (text, selection) => latestTarget.current.commitDraft(text, selection),
        onStateChange: setState,
      }),
    };
  }

  const { controller, recorder } = runtimeRef.current;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the real background
      // state cancels preparation; recorder status handles calls and route interruptions during
      // capture.
      if (nextState === "background") void controller.appMovedToBackground();
    });

    return () => subscription.remove();
  }, [controller]);

  useEffect(
    () => () => {
      // Dispose first so an active recording is stopped before the recorder is released.
      controller.dispose();
      recorder.release();
    },
    [controller, recorder],
  );

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);

    activation.catch(() => {});

    return () => {
      // Release after activation settles, even if the recording ends immediately.
      activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }

    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }

    if (state.phase !== "recording") return;

    function sampleRecording() {
      if (controller.currentState.phase !== "recording") return;

      const status = recorder.getStatus();

      if (!status?.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;

      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];

        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );

      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    }

    sampleRecording();

    const intervalId = setInterval(sampleRecording, 80);

    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  return {
    isAvailable,
    state,
    presentation: resolveVoiceComposerPresentation(state, elapsedSeconds),
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    start: () => void controller.start(),
    stop: () => void controller.stop(),
    cancel: () => controller.cancel(),
  };
}
