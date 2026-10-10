import { Pressable } from "react-native";
import Animated from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Reusables' animated wrapper; this app is native only, so it always animates. */
function NativeOnlyAnimatedView(
  props:
    | (React.ComponentProps<typeof Animated.View> & { as?: "View" })
    | (React.ComponentProps<typeof AnimatedPressable> & { as: "Pressable" }),
) {
  if (props.as === "Pressable") return <AnimatedPressable {...props} />;

  return <Animated.View {...props} />;
}

export { NativeOnlyAnimatedView };
