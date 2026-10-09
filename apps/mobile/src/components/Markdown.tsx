import { useColorScheme, View } from "react-native";
import { useMarkdown } from "react-native-marked";
import { useCSSVariable, useResolveClassNames } from "uniwind";

/** The agent's markdown, styled as on the desktop; the renderer only takes style objects, so they're resolved from classes. */
export function Markdown({ text, isMuted = false }: { text: string; isMuted?: boolean }) {
  const colorScheme = useColorScheme();

  const textStyle = useResolveClassNames(
    isMuted
      ? "font-sans text-sm leading-6 text-muted-foreground"
      : "font-sans text-[15px] leading-6 text-foreground",
  );

  const paragraph = useResolveClassNames("py-2");
  const h1 = useResolveClassNames("mt-4 mb-1 font-sans text-lg font-semibold text-foreground");

  const heading = useResolveClassNames(
    "mt-3 mb-1 font-sans text-base font-semibold text-foreground",
  );

  const codeBlock = useResolveClassNames("my-2 rounded-2xl bg-muted/80 p-3.5");
  const codeText = useResolveClassNames("font-mono text-xs leading-5 text-foreground/85");

  const codespan = useResolveClassNames(
    "bg-transparent font-mono text-[13px] not-italic text-brand",
  );

  const link = useResolveClassNames("text-brand not-italic underline");
  const blockquote = useResolveClassNames("my-1 border-l-2 border-border-strong pl-3");
  const listItem = useResolveClassNames("font-sans text-[15px] leading-6 text-foreground");
  const strong = useResolveClassNames("font-sans font-semibold text-foreground");
  const brand = useCSSVariable("--color-brand");
  const border = useCSSVariable("--color-border-strong");
  const muted = useCSSVariable("--color-muted");

  const elements = useMarkdown(text, {
    colorScheme: colorScheme ?? undefined,
    theme: {
      colors: {
        link: String(brand),
        border: String(border),
        code: String(muted),
        text: String(textStyle.color),
      },
    },
    styles: {
      text: textStyle,
      paragraph,
      h1,
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
