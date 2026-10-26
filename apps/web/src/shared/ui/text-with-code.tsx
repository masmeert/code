/** Messages mark commands with backticks; they read as code, not as literal backticks. */
export function TextWithCode({ text }: { text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="selectable font-mono">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
