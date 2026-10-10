import { useEffect, useRef } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  type EasingFunctionFactory,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from "react-native-svg";

/**
 * The desktop's orb face, without WebGL: a painted sphere whose eyes carry the agent's state. It
 * looks away while it thinks, narrows its eyes while it writes, hops when it's done, and goes
 * spiral-eyed when it breaks. Sizes and shapes are in the desktop's 100-unit viewBox.
 */
export type OrbFaceState = "idle" | "thinking" | "streaming" | "done" | "error";

const EYE_OFFSET = 16;

const EYE_Y = 44;

const EYE_WIDTH = 11;

const EYE_HEIGHT = 26;

const EYE_RADIUS = 5.5;

const GAZE_RANGE = 5.5;

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

const EASE_IN = Easing.bezier(0.4, 0, 1, 1);

/**
 * The desktop's peach body (copper is oklch(75% 0.13 55)), pre-desaturated the way its
 * `saturate-75` (idle) and `saturate-30` (error) filters do: iOS views have no saturate filter.
 */
const BODY_STOPS = {
  lively: ["#fff4ea", "#ffc799", "#ed9658"],
  idle: ["#fdf4ed", "#f3c9a7", "#db9a6b"],
  error: ["#f8f5f2", "#decdbf", "#baa08d"],
} as const;

const SPIRAL = "M0 0C-0.6 -4 5 -5 6 -0.6C7 4.5 1 8 -4 6C-9 4.5 -9.5 -2 -6 -6";

const SACCADE_TARGETS = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -0.6, y: -0.4 },
  { x: 0.8, y: -0.9 },
] as const;

type EyePose = { height: number; width: number; rotate: number; offsetY: number };

function eye(height: number, width = 1, rotate = 0, offsetY = 0): EyePose {
  return { height, width, rotate, offsetY };
}

const EXPRESSIONS: Record<Exclude<OrbFaceState, "error">, { left: EyePose; right: EyePose }> = {
  idle: { left: eye(1), right: eye(1) },
  thinking: { left: eye(1), right: eye(0.45, 1.1, -14) },
  streaming: { left: eye(0.55, 1.05), right: eye(0.55, 1.05) },
  done: { left: eye(0.16, 1.25, 0, 2), right: eye(0.16, 1.25, 0, 2) },
};

function keyframes(values: number[], durationsMs: number[], easing: EasingFunctionFactory) {
  return withSequence(
    ...values
      .slice(1)
      .map((value, index) => withTiming(value, { duration: durationsMs[index], easing })),
  );
}

export function OrbFace({ state = "idle", size }: { state?: OrbFaceState; size: number }) {
  const unit = size / 100;
  const reducedMotion = useReducedMotion();
  const lid = useSharedValue(1);
  const gazeX = useSharedValue(0);
  const gazeY = useSharedValue(0);
  const spin = useSharedValue(0);
  const bodyX = useSharedValue(0);
  const bodyY = useSharedValue(0);
  const bodyRotate = useSharedValue(0);
  const bodyScaleX = useSharedValue(1);
  const bodyScaleY = useSharedValue(1);
  const thinking = state === "thinking";
  const broken = state === "error";
  const bodyStops = BODY_STOPS[state === "idle" || broken ? state : "lively"];

  // Snap shut, ease back open: an even-timed blink reads as a machine.
  useEffect(() => {
    if (reducedMotion || broken) return;
    let timeout: ReturnType<typeof setTimeout>;

    function schedule() {
      timeout = setTimeout(
        () => {
          const close = { duration: 70, easing: EASE_IN };
          const open = { duration: 160, easing: EASE_OUT };
          lid.value =
            Math.random() < 0.25
              ? withSequence(
                  withTiming(0.08, close),
                  withTiming(1, close),
                  withTiming(0.08, close),
                  withTiming(1, open),
                )
              : withSequence(withTiming(0.08, close), withTiming(1, open));
          schedule();
        },
        3200 + Math.random() * 2600,
      );
    }

    schedule();

    return () => clearTimeout(timeout);
  }, [broken, lid, reducedMotion]);

  // Looking away and up is what makes thinking legible; there's no pointer to follow otherwise.
  useEffect(() => {
    if (!thinking || reducedMotion) return;
    const spring = { damping: 26, stiffness: 220 };
    let timeout: ReturnType<typeof setTimeout>;
    let index = 0;

    function schedule() {
      timeout = setTimeout(
        () => {
          const target = SACCADE_TARGETS[index % SACCADE_TARGETS.length]!;
          index += 1;
          gazeX.value = withSpring(target.x * GAZE_RANGE, spring);
          gazeY.value = withSpring(target.y * GAZE_RANGE, spring);
          schedule();
        },
        700 + Math.random() * 700,
      );
    }

    schedule();

    return () => {
      clearTimeout(timeout);
      gazeX.value = withSpring(0, spring);
      gazeY.value = withSpring(0, spring);
    };
  }, [gazeX, gazeY, thinking, reducedMotion]);

  // One dizzy wobble; the spiral eyes stay for as long as the state is `error`.
  useEffect(() => {
    if (!broken || reducedMotion) return;
    const easing = Easing.bezier(0.45, 0, 0.55, 1);
    const stepsMs = Array(6).fill(175);
    bodyRotate.value = keyframes([0, -11, 9, -7, 5, -3, 0], stepsMs, easing);
    bodyX.value = keyframes([0, -5, 4, -3, 2, -1, 0], stepsMs, easing);
    spin.value = 0;
    spin.value = withRepeat(withTiming(360, { duration: 2400, easing: Easing.linear }), -1);

    return () => cancelAnimation(spin);
  }, [bodyRotate, bodyX, broken, reducedMotion, spin]);

  // A happy hop, only on arrival, so reopening a finished thread doesn't make it jump.
  const previousState = useRef(state);
  useEffect(() => {
    const arrived = state === "done" && previousState.current !== "done";
    previousState.current = state;

    if (!arrived || reducedMotion) return;
    const stepsMs = [102, 238, 187, 170, 153];
    bodyScaleX.value = keyframes([1, 1.08, 0.94, 1.04, 0.99, 1], stepsMs, EASE_OUT);
    bodyScaleY.value = keyframes([1, 0.9, 1.08, 0.95, 1.02, 1], stepsMs, EASE_OUT);
    bodyY.value = keyframes([0, 3, -9, 0, -3, 0], stepsMs, EASE_OUT);
  }, [bodyScaleX, bodyScaleY, bodyY, state, reducedMotion]);

  const bodyStyle = useAnimatedStyle(() => ({
    width: size,
    height: size,
    transform: [
      { translateX: bodyX.value },
      { translateY: bodyY.value },
      { rotate: `${bodyRotate.value}deg` },
      { scaleX: bodyScaleX.value },
      { scaleY: bodyScaleY.value },
    ],
  }));

  return (
    <Animated.View aria-hidden style={bodyStyle}>
      <Svg viewBox="0 0 100 100" width="100%" height="100%">
        <Defs>
          <RadialGradient
            id="orb-body"
            gradientUnits="userSpaceOnUse"
            cx={34.6}
            cy={30.8}
            fx={34.6}
            fy={30.8}
            r={92}
          >
            <Stop offset={0} stopColor={bodyStops[0]} />
            <Stop offset={0.45} stopColor={bodyStops[1]} />
            <Stop offset={1} stopColor={bodyStops[2]} />
          </RadialGradient>
        </Defs>
        <Circle cx={50} cy={50} r={48} fill="url(#orb-body)" />
      </Svg>
      {broken ? (
        <>
          <DizzyEye side={-1} unit={unit} spin={spin} />
          <DizzyEye side={1} unit={unit} spin={spin} />
        </>
      ) : (
        <>
          <Eye
            side={-1}
            pose={EXPRESSIONS[state].left}
            unit={unit}
            lid={lid}
            gazeX={gazeX}
            gazeY={gazeY}
            reducedMotion={reducedMotion}
          />
          <Eye
            side={1}
            pose={EXPRESSIONS[state].right}
            unit={unit}
            lid={lid}
            gazeX={gazeX}
            gazeY={gazeY}
            reducedMotion={reducedMotion}
          />
        </>
      )}
    </Animated.View>
  );
}

function Eye({
  side,
  pose,
  unit,
  lid,
  gazeX,
  gazeY,
  reducedMotion,
}: {
  side: -1 | 1;
  pose: EyePose;
  unit: number;
  lid: SharedValue<number>;
  gazeX: SharedValue<number>;
  gazeY: SharedValue<number>;
  reducedMotion: boolean;
}) {
  const height = useSharedValue(pose.height);
  const width = useSharedValue(pose.width);
  const rotate = useSharedValue(pose.rotate);
  const offsetY = useSharedValue(pose.offsetY);

  useEffect(() => {
    function to(value: number) {
      return reducedMotion ? value : withSpring(value, { duration: 250, dampingRatio: 0.9 });
    }

    height.value = to(pose.height);
    width.value = to(pose.width);
    rotate.value = to(pose.rotate);
    offsetY.value = to(pose.offsetY);
  }, [height, offsetY, reducedMotion, rotate, pose, width]);

  const style = useAnimatedStyle(() => {
    const eyeWidth = EYE_WIDTH * width.value;
    const eyeHeight = Math.max(EYE_HEIGHT * height.value, 0.5);

    return {
      left: (50 + side * EYE_OFFSET - eyeWidth / 2) * unit,
      // Centred as it opens and closes, so a squint reads as lids meeting, not the eye sliding up.
      top: (EYE_Y + EYE_HEIGHT / 2 + offsetY.value - eyeHeight / 2) * unit,
      width: eyeWidth * unit,
      height: eyeHeight * unit,
      // The radius follows the height down, so a shutting eye becomes a lozenge, not a rectangle.
      borderRadius: Math.min(EYE_RADIUS * width.value, eyeHeight / 2) * unit,
      transform: [
        { translateX: gazeX.value * unit },
        { translateY: gazeY.value * unit },
        { rotate: `${rotate.value}deg` },
        { scaleY: lid.value },
      ],
    };
  });

  return <Animated.View className="absolute bg-[#101010]" style={style} />;
}

function DizzyEye({ side, unit, spin }: { side: -1 | 1; unit: number; spin: SharedValue<number> }) {
  // The spiral is drawn around its own origin at 1.5×; a 22-unit box holds it with its stroke.
  const box = 22 * 1.5 * unit;

  const style = useAnimatedStyle(() => ({
    left: (50 + side * EYE_OFFSET) * unit - box / 2,
    top: (EYE_Y + EYE_HEIGHT / 2) * unit - box / 2,
    width: box,
    height: box,
    transform: [{ rotate: `${spin.value * side}deg` }],
  }));

  return (
    <Animated.View className="absolute" style={style}>
      <Svg viewBox="-11 -11 22 22" width="100%" height="100%">
        <Path d={SPIRAL} fill="none" stroke="#101010" strokeWidth={3} strokeLinecap="round" />
      </Svg>
    </Animated.View>
  );
}
