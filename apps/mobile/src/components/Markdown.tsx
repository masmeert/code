import { useColorScheme, View } from "react-native";
import { useMarkdown } from "react-native-marked";
import { useCSSVariable, useResolveClassNames } from "uniwind";

/** The agent's markdown in the app's type and colors; the renderer only takes style objects, so they're resolved from classes. */
export function Markdown({ text, isMuted = false }: { text: string; isMuted?: boolean }) {
  const colorScheme = useColorScheme();

  const textStyle = useResolveClassNames(
    isMuted ? "text-[15px] leading-6 text-muted" : "text-[16px] leading-6 text-foreground",
  );

  const paragraph = useResolveClassNames("my-1");
  const heading = useResolveClassNames("mt-3 mb-1 text-[17px] font-semibold text-foreground");
  const codeBlock = useResolveClassNames("my-2 rounded-xl bg-surface-secondary p-3");
  const codeText = useResolveClassNames("font-mono text-[13px] leading-5 text-foreground");
  const codespan = useResolveClassNames("font-mono text-[14px] not-italic text-foreground");
  const link = useResolveClassNames("text-link underline");
  const blockquote = useResolveClassNames("my-1 border-l-2 border-separator pl-3");
  const listItem = useResolveClassNames("text-[16px] leading-6 text-foreground");
  const strong = useResolveClassNames("font-semibold text-foreground");
  const accent = useCSSVariable("--color-accent");
  const separator = useCSSVariable("--color-separator");
  const surface = useCSSVariable("--color-surface-secondary");

  const elements = useMarkdown(text, {
    colorScheme: colorScheme ?? undefined,
    theme: {
      colors: {
        link: String(accent),
        border: String(separator),
        code: String(surface),
        text: String(textStyle.color),
      },
    },
    styles: {
      text: textStyle,
      paragraph,
      h1: heading,
      h2: heading,
      h3: heading,
      h4: heading,
      code: codeBlock,
      codeText,
      codespan,
      link,
      blockquote,
      li: listItem,
      strong,
    },
  });

  return <View>{elements}</View>;
}
