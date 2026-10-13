import { Button, Host } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, disabled } from "@expo/ui/swift-ui/modifiers";
import { withUniwind } from "uniwind";

const StyledHost = withUniwind(Host);

const BUTTON_STYLE = {
  filled: "borderedProminent",
  outlined: "bordered",
  text: "borderless",
} as const;

/** A SwiftUI button, sized to its label, for React Native screens. */
export function NativeButton({
  label,
  variant = "filled",
  size = "regular",
  isDisabled = false,
  className,
  onPress,
}: {
  label: string;
  variant?: keyof typeof BUTTON_STYLE;
  size?: "small" | "regular";
  isDisabled?: boolean;
  className?: string;
  onPress: () => void;
}) {
  return (
    <StyledHost matchContents className={className}>
      <Button
        label={label}
        onPress={onPress}
        modifiers={[buttonStyle(BUTTON_STYLE[variant]), controlSize(size), disabled(isDisabled)]}
      />
    </StyledHost>
  );
}
