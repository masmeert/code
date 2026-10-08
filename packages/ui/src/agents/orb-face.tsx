import { motion, useAnimationControls, useReducedMotion, useSpring } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "@apcode/ui/lib/utils";
import { Orb } from "@apcode/ui/motion/orb";

/**
 * A little character whose expression carries the agent's state: it looks away while it thinks,
 * narrows its eyes while it writes, hops with happy arcs when it's done, and goes spiral-eyed when
 * it breaks. Ported from SmoothUI's AI Orb Face (github.com/educlopez/smoothui) in Vesper colours.
 *
 * `done` hops when the state changes to it, not when a face mounts already done.
 */
export type OrbFaceState = "idle" | "thinking" | "streaming" | "done" | "error";

/** Vesper peach between copper and cream: peach on white alone has too little range to marble. */
const BODY_COLORS = ["oklch(75% 0.13 55)", "#ffc799", "#fff4ea"];

const VIEWBOX = 100;
const CENTER = VIEWBOX / 2;
const EYE_OFFSET = 16;
const EYE_Y = 44;
const EYE_WIDTH = 11;
const EYE_HEIGHT = 26;
const EYE_RADIUS = 5.5;
/** How far the pupils travel from centre, in viewBox units. */
const GAZE_RANGE = 5.5;
/** Cursor distance at which the gaze reaches full deflection. */
const GAZE_FALLOFF_PX = 220;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const EASE_IN = [0.4, 0, 1, 1] as const;
/** A ~1.25-turn swirl; spun in place it reads as dizzy. */
const SPIRAL = "M0 0C-0.6 -4 5 -5 6 -0.6C7 4.5 1 8 -4 6C-9 4.5 -9.5 -2 -6 -6";
/** Thinking saccades: the eyes look away and up, the way people search. */
const SACCADE_TARGETS = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -0.6, y: -0.4 },
  { x: 0.8, y: -0.9 },
] as const;

/**
 * An eye is a rounded capsule: tall and narrow is neutral, short and wide is a closed, content eye,
 * rotated inward is a scowl. There is no mouth: one drawn on a shader body reads as a sticker.
 */
type EyeShape = {
  /** Multiplier on the resting height. 0 is shut. */
  height: number;
  /** Multiplier on the resting width. */
  width: number;
  /** Degrees. Positive tilts the inner corner down. */
  rotate: number;
  /** Vertical offset in viewBox units. Negative sits the eye higher. */
  offsetY: number;
};

function eye(height: number, width = 1, rotate = 0, offsetY = 0): EyeShape {
  return { height, width, rotate, offsetY };
}

const EXPRESSIONS: Record<Exclude<OrbFaceState, "error">, { left: EyeShape; right: EyeShape }> = {
  idle: { left: eye(1), right: eye(1) },
  // One eye narrowed: not convinced yet.
  thinking: { left: eye(1), right: eye(0.45, 1.1, -14) },
  streaming: { left: eye(0.55, 1.05), right: eye(0.55, 1.05) },
  // Shut and curved down, which reads as content rather than asleep.
  done: { left: eye(0.16, 1.25, 0, 2), right: eye(0.16, 1.25, 0, 2) },
};

export function OrbFace({
  state = "idle",
  gaze = true,
  className,
  "aria-label": ariaLabel,
}: {
  state?: OrbFaceState;
  /** Follow the pointer. Turn off where many faces tracking the cursor would be noise. */
  gaze?: boolean;
  /** Size it with `size-*`; it defaults to `size-32`. */
  className?: string;
  /** Omit to keep the face decorative. */
  "aria-label"?: string;
}) {
  const reducedMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const leftLid = useAnimationControls();
  const rightLid = useAnimationControls();
  const body = useAnimationControls();
  const gazeX = useSpring(0, { damping: 26, stiffness: 220 });
  const gazeY = useSpring(0, { damping: 26, stiffness: 220 });
  const thinking = state === "thinking";
  const broken = state === "error";

  // A blink spans several awaits, and animation controls throw if driven after unmount.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Snap shut, ease back open: an even-timed blink reads as a machine.
  const blink = useCallback(
    async function blink(double: boolean): Promise<void> {
      const close = { duration: 0.07, ease: EASE_IN };
      if (!mountedRef.current) return;
      await Promise.all([
        leftLid.start({ scaleY: 0.08 }, close),
        rightLid.start({ scaleY: 0.08 }, close),
      ]);
      if (!mountedRef.current) return;
      const open = double ? close : { duration: 0.16, ease: EASE_OUT };
      await Promise.all([leftLid.start({ scaleY: 1 }, open), rightLid.start({ scaleY: 1 }, open)]);
      if (double) await blink(false);
    },
    [leftLid, rightLid],
  );

  useEffect(() => {
    if (reducedMotion || broken) return;
    let timeout: ReturnType<typeof setTimeout>;
    function schedule() {
      timeout = setTimeout(
        () => {
          void blink(Math.random() < 0.25);
          schedule();
        },
        3200 + Math.random() * 2600,
      );
    }
    schedule();
    return () => clearTimeout(timeout);
  }, [blink, broken, reducedMotion]);

  // Not while thinking: looking away is what makes thinking legible.
  useEffect(() => {
    if (!gaze || reducedMotion || thinking || broken) return;
    function follow(event: PointerEvent) {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const reach = Math.min(1, Math.hypot(dx, dy) / GAZE_FALLOFF_PX) * GAZE_RANGE;
      const angle = Math.atan2(dy, dx);
      gazeX.set(Math.cos(angle) * reach);
      gazeY.set(Math.sin(angle) * reach);
    }
    window.addEventListener("pointermove", follow);
    return () => window.removeEventListener("pointermove", follow);
  }, [gaze, gazeX, gazeY, thinking, broken, reducedMotion]);

  useEffect(() => {
    if (!thinking || reducedMotion) return;
    let timeout: ReturnType<typeof setTimeout>;
    let index = 0;
    function schedule() {
      timeout = setTimeout(
        () => {
          const target = SACCADE_TARGETS[index % SACCADE_TARGETS.length];
          index += 1;
          gazeX.set(target.x * GAZE_RANGE);
          gazeY.set(target.y * GAZE_RANGE);
          schedule();
        },
        700 + Math.random() * 700,
      );
    }
    schedule();
    return () => clearTimeout(timeout);
  }, [gazeX, gazeY, thinking, reducedMotion]);

  // One dizzy wobble; the spiral eyes stay for as long as the state is `error`, so a broken agent
  // never settles back into looking fine.
  useEffect(() => {
    if (!broken) return;
    gazeX.set(0);
    gazeY.set(0);
    if (reducedMotion) return;
    void body.start(
      { rotate: [0, -11, 9, -7, 5, -3, 0], x: [0, -5, 4, -3, 2, -1, 0] },
      { duration: 1.05, ease: [0.45, 0, 0.55, 1] },
    );
  }, [body, gazeX, gazeY, broken, reducedMotion]);

  // A happy hop: the squash and stretch is the whole payload. Only on arrival, so reopening a
  // finished thread doesn't make it jump.
  const previousState = useRef(state);
  useEffect(() => {
    const arrived = state === "done" && previousState.current !== "done";
    previousState.current = state;
    if (!arrived || reducedMotion) return;
    void body.start(
      {
        scaleX: [1, 1.08, 0.94, 1.04, 0.99, 1],
        scaleY: [1, 0.9, 1.08, 0.95, 1.02, 1],
        y: [0, 3, -9, 0, -3, 0],
      },
      { duration: 0.85, ease: EASE_OUT, times: [0, 0.12, 0.4, 0.62, 0.82, 1] },
    );
  }, [body, state, reducedMotion]);

  function renderEye(side: -1 | 1, shape: EyeShape) {
    const width = EYE_WIDTH * shape.width;
    const height = Math.max(EYE_HEIGHT * shape.height, 0.5);
    const x = CENTER + side * EYE_OFFSET - width / 2;
    // Centred as it opens and closes, so a squint reads as lids meeting, not the eye sliding up.
    const y = EYE_Y + (EYE_HEIGHT - height) / 2 + shape.offsetY;
    return (
      <motion.rect
        animate={side === -1 ? leftLid : rightLid}
        initial={{ scaleY: 1 }}
        className="fill-[#101010]"
        x={x}
        y={y}
        width={width}
        height={height}
        // The radius follows the height down, so a shutting eye becomes a lozenge, not a rectangle.
        rx={Math.min(EYE_RADIUS * shape.width, height / 2)}
        style={{
          rotate: shape.rotate,
          transformOrigin: `${x + width / 2}px ${y + height / 2}px`,
          x: gazeX,
          y: gazeY,
        }}
        transition={
          reducedMotion ? { duration: 0 } : { type: "spring", bounce: 0.1, duration: 0.25 }
        }
      />
    );
  }

  function renderDizzyEye(side: -1 | 1) {
    return (
      <motion.path
        d={SPIRAL}
        className="fill-none stroke-[#101010]"
        strokeWidth={3}
        strokeLinecap="round"
        animate={reducedMotion ? undefined : { rotate: 360 * side }}
        transition={{ duration: 2.4, ease: "linear", repeat: Infinity }}
        style={{ scale: 1.5, x: CENTER + side * EYE_OFFSET, y: EYE_Y + EYE_HEIGHT / 2 }}
      />
    );
  }

  return (
    <div
      className={cn(
        "relative size-32",
        state === "idle" && "saturate-75",
        broken && "saturate-30",
        className,
      )}
    >
      {/* The orb draws its sphere at 86% of its box; this inset scales the box so the sphere lands
          on the r=48 circle the face is drawn around. */}
      <motion.div animate={body} className="absolute -inset-[5.814%]">
        {/* Painted understudy: with many WebGL surfaces on a page the browser reclaims the oldest
            contexts, and a reclaimed orb would leave a pair of floating eyes. */}
        <div className="absolute inset-[7%] rounded-full bg-[radial-gradient(circle_at_34%_30%,#fff4ea,#ffc799_45%,oklch(75%_0.13_55))]" />
        <Orb colors={BODY_COLORS} className="relative size-full" />
      </motion.div>
      <motion.svg
        ref={svgRef}
        animate={body}
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        role={ariaLabel ? "img" : undefined}
        aria-label={ariaLabel}
        aria-hidden={ariaLabel ? undefined : true}
        className="absolute inset-0 size-full overflow-visible"
      >
        {broken ? (
          <>
            {renderDizzyEye(-1)}
            {renderDizzyEye(1)}
          </>
        ) : (
          <>
            {renderEye(-1, EXPRESSIONS[state].left)}
            {renderEye(1, EXPRESSIONS[state].right)}
          </>
        )}
      </motion.svg>
    </div>
  );
}
