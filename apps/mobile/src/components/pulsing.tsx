import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/** Fades in and out while something is live, as the desktop's `animate-pulse` does. */
export function Pulsing({
  isLive = true,
  className,
  children,
}: {
  isLive?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const opacity = useSharedValue(1);
  const isReducedMotion = useReducedMotion();

  useEffect(() => {
    if (!isLive || isReducedMotion) return;

    opacity.value = withRepeat(withTiming(0.35, { duration: 1000 }), -1, true);

    return () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
  }, [isLive, isReducedMotion, opacity]);

  // Uniwind has no animation classes, so the fade runs on Reanimated.
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View className={className} style={style}>
      {children}
    </Animated.View>
  );
}
