import type { SFSymbol } from "expo-symbols";
import { memo, type ReactNode, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import Animated, {
  Easing,
  type EntryExitAnimationFunction,
  type LayoutAnimationFunction,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { cn } from "@/lib/cn.ts";
import type { VoiceInputPhase, VoiceInputState } from "@/lib/voice-input/controller.ts";
import {
  VOICE_WAVEFORM_SAMPLE_COUNT,
  type VoiceComposerPresentation,
} from "@/lib/voice-input/use-voice-input.ts";
import { Icon } from "./ui/icon.tsx";
import { Text } from "./ui/text.tsx";

const DICTATION_TIMING = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};

const TOOLBAR_FLIP_TIMING = {
  duration: 260,
  easing: Easing.inOut(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};

const TOOLBAR_HALF_HEIGHT = 22;

const TOOLBAR_PERSPECTIVE = 600;

/** Moves each face around the same horizontal axis, keeping their edges together. */
function toolbarFlip(fromDegrees: number, toDegrees: number): EntryExitAnimationFunction {
  return () => {
    "worklet";

    const fromRadians = (fromDegrees * Math.PI) / 180;
    const toRadians = (toDegrees * Math.PI) / 180;
    const fromSine = Math.sin(fromRadians);
    const toSine = Math.sin(toRadians);

    return {
      initialValues: {
        opacity: fromDegrees === 0 ? 1 : 0,
        transform: [
          { perspective: TOOLBAR_PERSPECTIVE },
          { translateY: -TOOLBAR_HALF_HEIGHT * fromSine },
          { rotateX: `${fromDegrees}deg` },
        ],
      },
      animations: {
        opacity: withTiming(toDegrees === 0 ? 1 : 0, TOOLBAR_FLIP_TIMING),
        transform: [
          { perspective: TOOLBAR_PERSPECTIVE },
          {
            translateY: withTiming(-TOOLBAR_HALF_HEIGHT * toSine, {
              ...TOOLBAR_FLIP_TIMING,
              easing: (time) => {
                const angle =
                  fromRadians + (toRadians - fromRadians) * TOOLBAR_FLIP_TIMING.easing(time);

                return (Math.sin(angle) - fromSine) / (toSine - fromSine);
              },
            }),
          },
          { rotateX: withTiming(`${toDegrees}deg`, TOOLBAR_FLIP_TIMING) },
        ],
      },
    };
  };
}

const DRAFT_TOOLBAR_ENTERING = toolbarFlip(90, 0);

const DRAFT_TOOLBAR_EXITING = toolbarFlip(0, 90);

const DICTATION_TOOLBAR_ENTERING = toolbarFlip(-90, 0);

const DICTATION_TOOLBAR_EXITING = toolbarFlip(0, -90);

const WAVEFORM_BAR_HEIGHT = 32;

const WAVEFORM_TIMING = {
  duration: 100,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
};

/** Rotates the compact draft away without unmounting or resizing its text field. */
export function ComposerDictationDraftContent({
  children,
  className,
  layout,
  compact,
  hidden,
}: {
  children: ReactNode;
  className?: string;
  layout: LayoutAnimationFunction;
  compact: boolean;
  hidden: boolean;
}) {
  const rotation = useSharedValue(hidden ? 1 : 0);

  useLayoutEffect(() => {
    rotation.value = withTiming(hidden ? 1 : 0, TOOLBAR_FLIP_TIMING);
  }, [hidden, rotation]);

  // The flip is a running animation, which classes can't drive.
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: compact ? 1 - rotation.value : 1,
    transform: compact
      ? [
          { perspective: TOOLBAR_PERSPECTIVE },
          { translateY: -TOOLBAR_HALF_HEIGHT * Math.sin((rotation.value * Math.PI) / 2) },
          { rotateX: `${rotation.value * 90}deg` },
        ]
      : [],
  }));

  return (
    <Animated.View
      accessibilityElementsHidden={hidden}
      collapsable={false}
      className={className}
      layout={layout}
      pointerEvents={hidden ? "none" : "auto"}
      style={animatedStyle}
    >
      {children}
    </Animated.View>
  );
}

/** Flips the entire row while keeping the outgoing controls intact until it leaves. */
export function ComposerDictationToolbar({
  children,
  showsDictation,
  visible,
}: {
  children: ReactNode;
  showsDictation: boolean;
  visible: boolean;
}) {
  return (
    <View className="relative h-11 overflow-hidden">
      {visible ? (
        <Animated.View
          key={showsDictation ? "dictation" : "draft"}
          className="absolute inset-0 flex-row items-center gap-1.5"
          entering={showsDictation ? DICTATION_TOOLBAR_ENTERING : DRAFT_TOOLBAR_ENTERING}
          exiting={showsDictation ? DICTATION_TOOLBAR_EXITING : DRAFT_TOOLBAR_EXITING}
        >
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}

const WaveformBar = memo(function WaveformBar({
  audioLevels,
  sampleIndex,
}: {
  audioLevels: SharedValue<number[]>;
  sampleIndex: number;
}) {
  // Follows the mic level sampled on the UI thread, which classes can't drive.
  const animatedStyle = useAnimatedStyle(() => {
    const level = audioLevels.value[sampleIndex] ?? 0;

    return {
      opacity: withTiming(0.22 + level * 0.78, WAVEFORM_TIMING),
      transform: [
        {
          scaleY: withTiming(
            (2 + level * (WAVEFORM_BAR_HEIGHT - 2)) / WAVEFORM_BAR_HEIGHT,
            WAVEFORM_TIMING,
          ),
        },
      ],
    };
  });

  return <Animated.View className="h-8 w-0.5 rounded-full bg-foreground" style={animatedStyle} />;
});

/** As many of the latest samples as fit, oldest on the left. */
const VoiceWaveform = memo(function VoiceWaveform({
  audioLevels,
}: {
  audioLevels: SharedValue<number[]>;
}) {
  const [barCount, setBarCount] = useState(0);

  return (
    <View
      accessibilityElementsHidden
      className="h-8 min-w-0 flex-1 flex-row items-center justify-between overflow-hidden"
      onLayout={(event) =>
        setBarCount(
          Math.max(
            1,
            Math.min(VOICE_WAVEFORM_SAMPLE_COUNT, Math.floor(event.nativeEvent.layout.width / 5)),
          ),
        )
      }
    >
      {Array.from({ length: barCount }, (_, index) => (
        <WaveformBar
          key={index}
          audioLevels={audioLevels}
          sampleIndex={VOICE_WAVEFORM_SAMPLE_COUNT - barCount + index}
        />
      ))}
    </View>
  );
});

function VoiceActionButton({
  accessibilityLabel,
  disabled,
  icon,
  loading,
  onPress,
  variant = "plain",
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: SFSymbol;
  loading?: boolean;
  onPress: () => void;
  variant?: "plain" | "primary";
}) {
  const loadingVisibility = useSharedValue(loading ? 1 : 0);

  useLayoutEffect(() => {
    loadingVisibility.value = withTiming(loading ? 1 : 0, DICTATION_TIMING);
  }, [loadingVisibility, loading]);

  // Cross-fades the filled circle as loading settles, which classes can't animate.
  const primaryStyle = useAnimatedStyle(() => ({ opacity: 1 - loadingVisibility.value }));

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled }}
      className={cn(
        "size-11 shrink-0 items-center justify-center active:opacity-70",
        disabled && !loading && "opacity-40",
      )}
      disabled={disabled}
      onPress={onPress}
    >
      <View
        className={cn(
          "items-center justify-center",
          variant === "primary" ? "size-[30px] rounded-full bg-primary/15" : "size-11",
        )}
      >
        {variant === "primary" ? (
          <Animated.View
            className="absolute inset-0 rounded-full bg-primary"
            style={primaryStyle}
          />
        ) : null}
        <View className="absolute inset-0 items-center justify-center">
          {loading ? (
            <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
          ) : (
            <Icon
              name={icon}
              weight={variant === "primary" ? "semibold" : "regular"}
              className={variant === "primary" ? "size-4 text-primary-foreground" : "size-5"}
            />
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** The toolbar's middle while dictating: the waveform and time, the phase, or the error. */
export function ComposerDictationStatus({
  audioLevels,
  elapsedSeconds,
  phase,
  presentation,
  onDismissError,
}: {
  audioLevels: SharedValue<number[]>;
  elapsedSeconds: number;
  phase: VoiceInputPhase;
  presentation: VoiceComposerPresentation;
  onDismissError: () => void;
}) {
  const recordingVisibility = useSharedValue(phase === "recording" ? 1 : 0);

  useLayoutEffect(() => {
    recordingVisibility.value = withTiming(phase === "recording" ? 1 : 0, DICTATION_TIMING);
  }, [phase, recordingVisibility]);

  // Cross-fades the waveform and the phase label, which classes can't animate.
  const waveformStyle = useAnimatedStyle(() => ({ opacity: recordingVisibility.value }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: 1 - recordingVisibility.value }));

  if (!presentation.statusLabel) return null;

  return (
    <View className="relative h-11 min-w-0 flex-1 justify-center">
      {presentation.statusKind === "error" ? (
        <View className="min-w-0 flex-row items-center gap-1.5 px-2">
          <Text className="min-w-0 flex-1 text-sm text-destructive" numberOfLines={2}>
            {presentation.statusLabel}
          </Text>
          <Pressable
            accessibilityLabel="Dismiss dictation error"
            accessibilityRole="button"
            className="size-7 items-center justify-center active:opacity-70"
            hitSlop={8}
            onPress={onDismissError}
          >
            <Icon name="xmark" className="size-3 text-muted-foreground" />
          </Pressable>
        </View>
      ) : (
        <View
          accessible
          accessibilityLabel={presentation.statusLabel}
          accessibilityLiveRegion={phase === "recording" ? "none" : "polite"}
          className="h-11"
        >
          <Animated.View
            className="absolute inset-0 min-w-0 flex-row items-center gap-2 px-1"
            style={waveformStyle}
          >
            <VoiceWaveform audioLevels={audioLevels} />
            <Text numberOfLines={1} className="text-xs text-muted-foreground tabular-nums">
              {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")}
            </Text>
          </Animated.View>
          <Animated.View className="absolute inset-0 justify-center px-2" style={labelStyle}>
            <Text className="text-center text-sm text-muted-foreground" numberOfLines={1}>
              {presentation.statusLabel}
            </Text>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

export function ComposerDictationCancelAction({
  presentation,
  onCancel,
}: {
  presentation: VoiceComposerPresentation;
  onCancel: () => void;
}) {
  if (presentation.leadingAction !== "cancel") return null;

  return (
    <VoiceActionButton accessibilityLabel="Cancel dictation" icon="xmark" onPress={onCancel} />
  );
}

/** Finishes the recording while dictating, else starts one. */
export function ComposerDictationPrimaryAction({
  presentation,
  onConfirm,
  ...startProps
}: {
  state: VoiceInputState;
  presentation: VoiceComposerPresentation;
  isAvailable: boolean;
  onStart: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (presentation.trailingAction === "confirm") {
    return (
      <VoiceActionButton
        accessibilityLabel={
          presentation.confirmationEnabled
            ? "Finish dictation"
            : (presentation.statusLabel ?? "Preparing dictation")
        }
        disabled={!presentation.confirmationEnabled}
        icon="checkmark"
        loading={!presentation.confirmationEnabled}
        onPress={onConfirm}
        variant="primary"
      />
    );
  }

  return <ComposerDictationStartAction {...startProps} />;
}

/** The mic; once the microphone is denied for good, it opens Settings instead. */
export function ComposerDictationStartAction({
  state,
  isAvailable,
  onStart,
  onCancel,
}: {
  state: VoiceInputState;
  isAvailable: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  if (!isAvailable) return null;

  const opensSettings = state.phase === "error" && state.errorAction === "settings";

  return (
    <VoiceActionButton
      accessibilityLabel={opensSettings ? "Open microphone settings" : "Start dictation"}
      icon="mic"
      onPress={
        opensSettings
          ? () => {
              onCancel();
              void Linking.openSettings();
            }
          : onStart
      }
    />
  );
}
