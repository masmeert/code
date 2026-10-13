import {
  Button,
  Form,
  HStack,
  Host,
  Image,
  LabeledContent,
  Picker,
  RNHostView,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  useNativeState,
  VStack,
} from "@expo/ui/swift-ui";
import {
  autocorrectionDisabled,
  buttonStyle,
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- @expo/ui names it after SwiftUI.
  contentShape as hitArea,
  disabled,
  font,
  foregroundStyle,
  keyboardType,
  labelsHidden,
  lineLimit,
  multilineTextAlignment,
  pickerStyle,
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- @expo/ui names it after SwiftUI.
  shapes as hitAreas,
  tag,
  textInputAutocapitalization,
  tint,
  truncationMode,
} from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "expo-symbols";
import type { ReactElement, ReactNode } from "react";
import { withUniwind } from "uniwind";

// Grouped rows in iOS's own controls: a SwiftUI Form and its rows.

const StyledHost = withUniwind(Host);

const MAX_INLINE_OPTIONS = 7;

/** The selection while computers differ, which no option matches, so none is checked. */
const MIXED = "(mixed)";

const SECONDARY = foregroundStyle({ type: "hierarchical", style: "secondary" });

// Rows are plain buttons, as @expo/ui's own ListItem: the default style would tint all their text.
// The hit area keeps the gaps between their parts tappable.
const ROW_BUTTON = [buttonStyle("plain"), hitArea(hitAreas.rectangle())];

/** A screen of grouped settings rows, scrolling on its own. */
export function FormList({ children }: { children: ReactNode }) {
  return (
    <StyledHost className="flex-1">
      <Form>{children}</Form>
    </StyledHost>
  );
}

export function FormSection({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <Section title={title} footer={footer ? <Text>{footer}</Text> : undefined}>
      {children}
    </Section>
  );
}

/** A row that opens another screen; `detail` is a second line under the label, `leading` React Native content in place of `icon`. */
export function FormLinkRow({
  icon,
  leading,
  label,
  detail,
  value,
  isDisabled = false,
  onPress,
}: {
  icon?: SFSymbol;
  leading?: ReactElement;
  label: string;
  detail?: string;
  value?: string;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button onPress={onPress} modifiers={[...ROW_BUTTON, disabled(isDisabled)]}>
      <HStack spacing={12}>
        {leading ? (
          <RNHostView matchContents>{leading}</RNHostView>
        ) : icon ? (
          <Image systemName={icon} />
        ) : null}
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[lineLimit(1)]}>{label}</Text>
          {detail ? (
            <Text
              modifiers={[
                font({ textStyle: "footnote" }),
                SECONDARY,
                lineLimit(1),
                truncationMode("middle"),
              ]}
            >
              {detail}
            </Text>
          ) : null}
        </VStack>
        <Spacer />
        {value ? <Text modifiers={[SECONDARY, lineLimit(1)]}>{value}</Text> : null}
        <Image
          systemName="chevron.right"
          modifiers={[
            font({ size: 13, weight: "semibold" }),
            foregroundStyle({ type: "hierarchical", style: "tertiary" }),
          ]}
        />
      </HStack>
    </Button>
  );
}

/** A row whose tap does `actionLabel` to it, like restoring an archived thread. */
export function FormActionRow({
  label,
  detail,
  actionLabel,
  onPress,
}: {
  label: string;
  detail?: string;
  actionLabel: string;
  onPress: () => void;
}) {
  return (
    <Button onPress={onPress} modifiers={ROW_BUTTON}>
      <HStack spacing={12}>
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[lineLimit(1)]}>{label}</Text>
          {detail ? (
            <Text modifiers={[font({ textStyle: "footnote" }), SECONDARY, lineLimit(1)]}>
              {detail}
            </Text>
          ) : null}
        </VStack>
        <Spacer />
        <Text modifiers={[foregroundStyle("blue")]}>{actionLabel}</Text>
      </HStack>
    </Button>
  );
}

/**
 * A setting as its own section listing every option, the current one checked; a null value is
 * computers that differ, which the footer says.
 */
export function FormChoiceSection<Value extends string>({
  title,
  description,
  value,
  options,
  onChange,
}: {
  title: string;
  description?: string;
  value: Value | null;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
}) {
  const footer =
    value === null
      ? [`The selected computers differ. Pick one to use it on all of them.`, description]
          .filter(Boolean)
          .join(" ")
      : description;

  // Listed in full, a long list like the models buries the settings after it; one row opens it as a menu.
  const isLong = options.length > MAX_INLINE_OPTIONS;

  return (
    <Section title={isLong ? undefined : title} footer={footer ? <Text>{footer}</Text> : undefined}>
      <Picker
        label={title}
        selection={value ?? MIXED}
        onSelectionChange={(chosen) => {
          const option = options.find((candidate) => candidate.value === chosen);

          if (option) onChange(option.value);
        }}
        modifiers={
          isLong
            ? [pickerStyle("menu"), tint({ type: "hierarchical", style: "secondary" })]
            : [pickerStyle("inline"), labelsHidden()]
        }
      >
        {options.map((option) => (
          <Text key={option.value} modifiers={[tag(option.value)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    </Section>
  );
}

export function FormSwitchRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return <Toggle label={label} isOn={value} onIsOnChange={onChange} />;
}

/** An action in the list; `isDestructive` turns it red, as iOS does for removing things. */
export function FormButtonRow({
  label,
  isDestructive = false,
  isDisabled = false,
  onPress,
}: {
  label: string;
  isDestructive?: boolean;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      label={label}
      role={isDestructive ? "destructive" : undefined}
      onPress={onPress}
      modifiers={[disabled(isDisabled)]}
    />
  );
}

/** A row that only shows something: a label over `detail` lines, `value` on the right, and React Native `leading` content. */
export function FormInfoRow({
  leading,
  label,
  detail,
  value,
}: {
  leading?: ReactElement;
  label: string;
  detail?: string;
  value?: string;
}) {
  return (
    <HStack spacing={12}>
      {leading ? <RNHostView matchContents>{leading}</RNHostView> : null}
      <VStack alignment="leading" spacing={2}>
        <Text>{label}</Text>
        {detail ? (
          <Text modifiers={[font({ textStyle: "footnote" }), SECONDARY]}>{detail}</Text>
        ) : null}
      </VStack>
      <Spacer />
      {value ? <Text modifiers={[SECONDARY, lineLimit(1)]}>{value}</Text> : null}
    </HStack>
  );
}

/** A labeled text field; the field holds its text, and `onChange` hears every edit. */
export function FormTextFieldRow({
  label,
  placeholder,
  keyboard,
  maxLength,
  onChange,
}: {
  label: string;
  placeholder: string;
  keyboard: "numbers-and-punctuation" | "number-pad";
  maxLength?: number;
  onChange: (text: string) => void;
}) {
  const text = useNativeState("");

  return (
    <LabeledContent label={label}>
      <TextField
        text={text}
        placeholder={placeholder}
        maxLength={maxLength}
        onTextChange={onChange}
        modifiers={[
          keyboardType(keyboard === "number-pad" ? "ascii-capable-number-pad" : keyboard),
          textInputAutocapitalization("never"),
          autocorrectionDisabled(),
          multilineTextAlignment("trailing"),
        ]}
      />
    </LabeledContent>
  );
}

/** A row holding React Native content as tall as it lays itself out, like a camera preview. */
export function FormContentRow({ children }: { children: ReactElement }) {
  return <RNHostView matchContents={{ vertical: true }}>{children}</RNHostView>;
}
