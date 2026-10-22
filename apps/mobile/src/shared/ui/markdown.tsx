import { parseThreadLink } from "@masscode/contracts";
import { type ReactNode, useMemo } from "react";
import { Text, type TextStyle, useColorScheme, View } from "react-native";
import { Renderer, useMarkdown } from "react-native-marked";
import { useCSSVariable, useResolveClassNames } from "uniwind";

/** Opens MassCode's thread links in the app; other links go to the browser as usual. */
class ThreadLinkRenderer extends Renderer {
  #links = 0;

  constructor(private readonly openThread: (threadId: string) => void) {
    super();
  }

  override link(children: string | ReactNode[], href: string, styles?: TextStyle, title?: string) {
    const threadId = parseThreadLink(href);

    if (!threadId) return super.link(children, href, styles, title);

    return (
      <Text
        key={`thread-link-${this.#links++}`}
        accessibilityRole="link"
        onPress={() => this.openThread(threadId)}
        style={styles}
      >
        {children}
      </Text>
    );
  }
}

/** The agent's markdown, styled as on the desktop; the renderer only takes style objects, so they're resolved from classes. */
export function Markdown({
  text,
  isMuted = false,
  onOpenThread,
}: {
  text: string;
  isMuted?: boolean;
  /** Where thread links go; without it they open like any link. */
  onOpenThread?: (threadId: string) => void;
}) {
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

  const renderer = useMemo(
    () => (onOpenThread ? new ThreadLinkRenderer(onOpenThread) : undefined),
    [onOpenThread],
  );

  const elements = useMarkdown(text, {
    renderer,
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
