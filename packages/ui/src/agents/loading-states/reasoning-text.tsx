import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { TextScramble } from "@apcode/ui/motion/text-scramble";
import { EASE_OUT, SPRING_SWAP } from "@apcode/ui/lib/ease";
import {
  TEXT_SHIMMER_CLASS_NAME,
  TEXT_SHIMMER_KEYFRAMES,
  textShimmerStyle,
} from "@apcode/ui/lib/text-shimmer";
import { cn } from "@apcode/ui/lib/utils";

const DEFAULT_PHRASES = [
  "Schlepping",
  "Combobulating",
  "Doing",
  "Channelling",
  "Vibing",
  "Concocting",
  "Spelunking",
  "Transmuting",
  "Imagining",
  "Pontificating",
  "Whirring",
  "Cogitating",
  "Honking",
  "Flibbertigibbeting",
  "Noodling",
  "Percolating",
  "Ruminating",
  "Simmering",
  "Marinating",
  "Fermenting",
  "Gestating",
  "Hatching",
  "Brewing",
  "Steeping",
  "Contemplating",
  "Musing",
  "Pondering",
  "Mulling",
  "Daydreaming",
  "Woolgathering",
  "Dithering",
  "Faffing",
  "Puttering",
  "Tinkering",
  "Fiddling",
  "Noodging",
  "Finagling",
  "Wrangling",
  "Jiggling",
  "Wiggling",
  "Shimmying",
  "Galumphing",
  "Perambulating",
  "Meandering",
  "Traipsing",
  "Moseying",
  "Sauntering",
  "Ambling",
  "Tokenmaxxing",
  "Consulting the void",
  "Asking the electrons",
  "Bribing the compiler",
  "Negotiating with entropy",
  "Whispering to the bits",
  "Tickling the stack",
  "Massaging the heap",
  "Appeasing the garbage collector",
  "Summoning semicolons",
  "Herding pointers",
  "Untangling spaghetti",
  "Polishing the algorithms",
  "Waxing philosophical",
  "Consulting ancient scrolls",
  "Reading tea leaves",
  "Shaking the magic 8-ball",
  "Sacrificing to the demo gods",
  "Warming up the hamsters",
  "Spinning up the squirrels",
  "Caffeinating",
  "Existentially questioning",
  "Having a little think",
  "Stroking chin thoughtfully",
  "Squinting at the problem",
  "Staring into the abyss",
  "Abyss staring back",
  "Achieving enlightenment",
  "Transcending mere computation",
  "Ascending to a higher plane",
  "Communing with the machine spirit",
  "Performing arcane rituals",
  "Invoking elder functions",
  "Consulting the oracle",
  "Divining the answer",
  "Scrying the codebase",
  "Dowsing for bugs",
  "Reticulating splines",
  "Reversing the polarity",
  "Calibrating the flux capacitor",
  "Charging the crystals",
  "Tuning the vibrations",
  "Adjusting the cosmic frequency",
  "Manifesting solutions",
  "Politely asking the CPU",
  "Bribing the runtime",
  "Sweet-talking the API",
  "Having words with the cache",
  "Pleading with the logs",
  "Consulting the rubber duck",
  "Interrogating the stack trace",
  "Cross-examining the debugger",
  "Petitioning the kernel",
  "Schmoozing the network",
  "Giving the code a pep talk",
  "Greasing the gears",
  "Oiling the cogs",
  "Feeding the machine",
  "Teaching old code new tricks",
  "Dancing with dependencies",
  "Tangoing with type errors",
  "Doing the deployment dance",
  "Convincing the pixels to cooperate",
  "Teaching electrons new tricks",
  "Negotiating with cosmic rays",
  "Charming the curly braces",
  "Hypnotizing the hash tables",
  "Bewitching the boolean logic",
  "Spellbinding the stack frames",
  "Exorcising the exceptions",
  "Untying the type knots",
  "Unraveling the regex",
  "Solving the riddles of RAM",
  "Unlocking the secrets of silicon",
  "Unearthing buried bugs",
  "Excavating ancient APIs",
  "Spelunking through the stack",
  "Scuba diving in the data",
  "Skydiving through the source",
  "Surfing the syntax waves",
  "Skateboarding down the stack trace",
  "Camping in the codebase",
  "Barbecuing the bugs",
  "Roasting the race conditions",
  "Sautéing the syntax errors",
  "Curing the code smells",
  "Decanting the data structures",
  "Aerating the arrays",
  "Letting the logic breathe",
  "Seasoning the solutions",
  "Presenting with pizzazz",
  "Sprinkling some magic dust",
  "Drizzling debug sauce",
  "Whisking the widgets",
  "Kneading the namespaces",
  "Rolling out the runtime",
  "Proofing the promises",
  "Baking at 350 kilobytes",
  "Frosting the functions",
  "Topping with tests",
  "Cherry-picking the commits",
  "Slop forking open source",
];

const CASCADE_STAGGER = 0.025;

export type ReasoningTextVariant = "cascade" | "swap" | "scramble";

export interface ReasoningTextProps {
  /** Phrases cycled through while the agent works. */
  phrases?: string[];
  /** Animation used when the active phrase changes. */
  variant?: ReasoningTextVariant;
  /** Milliseconds each phrase remains visible. */
  interval?: number;
  /** Seconds taken for one shimmer pass. */
  shimmerDuration?: number;
  className?: string;
}

type PhraseProps = {
  phrase: string;
  reduce: boolean;
  shimmerDuration: number;
};

function CascadePhrase({ phrase, reduce, shimmerDuration }: PhraseProps) {
  const text = `${phrase}…`;

  if (reduce) {
    return (
      <span
        className={cn(
          "col-start-1 row-start-1 inline-block justify-self-start whitespace-pre",
          TEXT_SHIMMER_CLASS_NAME,
        )}
        style={textShimmerStyle(shimmerDuration)}
      >
        {text}
      </span>
    );
  }

  return (
    <AnimatePresence initial={false}>
      <motion.span
        key={phrase}
        className="col-start-1 row-start-1 inline-block justify-self-start whitespace-pre"
        initial="initial"
        animate="animate"
        exit="exit"
      >
        {text.split("").map((character, characterIndex) => (
          <motion.span
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the stable cascade slot identity.
            key={characterIndex}
            custom={characterIndex * CASCADE_STAGGER}
            variants={{
              initial: { opacity: 0, y: "100%" },
              animate: (delay: number) => ({
                opacity: 1,
                y: "0%",
                transition: { ...SPRING_SWAP, delay },
              }),
              exit: (delay: number) => ({
                opacity: 0,
                y: "-100%",
                transition: {
                  duration: 0.14,
                  ease: EASE_OUT,
                  delay: delay * 0.45,
                },
              }),
            }}
            className={cn(
              "inline-block whitespace-pre will-change-[opacity,transform]",
              TEXT_SHIMMER_CLASS_NAME,
            )}
            style={textShimmerStyle(shimmerDuration)}
          >
            {character}
          </motion.span>
        ))}
      </motion.span>
    </AnimatePresence>
  );
}

function SwapPhrase({ phrase, reduce, shimmerDuration }: PhraseProps) {
  return (
    <AnimatePresence initial={false}>
      <motion.span
        key={phrase}
        className={cn(
          "col-start-1 row-start-1 inline-block justify-self-start whitespace-nowrap will-change-[opacity,transform]",
          TEXT_SHIMMER_CLASS_NAME,
        )}
        style={textShimmerStyle(shimmerDuration)}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 3 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
        transition={{
          duration: reduce ? 0.12 : 0.2,
          ease: EASE_OUT,
        }}
      >
        {phrase}…
      </motion.span>
    </AnimatePresence>
  );
}

function ScramblePhrase({ phrase, shimmerDuration }: PhraseProps) {
  const target = `${phrase}…`;

  return (
    <TextScramble
      text={target}
      className={cn(
        "col-start-1 row-start-1 justify-self-start tabular-nums",
        TEXT_SHIMMER_CLASS_NAME,
      )}
      style={textShimmerStyle(shimmerDuration)}
    />
  );
}

export function ReasoningText({
  phrases = DEFAULT_PHRASES,
  variant = "cascade",
  interval = 1800,
  shimmerDuration = 2.2,
  className,
}: ReasoningTextProps) {
  const reduce = useReducedMotion() ?? false;
  const [index, setIndex] = useState(() => Math.floor(Math.random() * phrases.length));
  const statusId = useId();
  const safePhrases = phrases.length > 0 ? phrases : DEFAULT_PHRASES;
  const phrase = safePhrases[index % safePhrases.length];
  const longestPhrase = safePhrases.reduce((longest, current) =>
    current.length > longest.length ? current : longest,
  );
  const phraseProps = { phrase, reduce, shimmerDuration };

  useEffect(() => {
    if (safePhrases.length < 2) return;

    const timer = window.setInterval(
      () => {
        setIndex(
          (current) =>
            (current + 1 + Math.floor(Math.random() * (safePhrases.length - 1))) %
            safePhrases.length,
        );
      },
      Math.max(600, interval),
    );

    return () => window.clearInterval(timer);
  }, [interval, safePhrases.length]);

  return (
    <>
      <style>{TEXT_SHIMMER_KEYFRAMES}</style>
      <span
        role="status"
        aria-live="polite"
        aria-labelledby={statusId}
        className={cn(
          "inline-flex items-center gap-2 text-sm font-medium text-muted-foreground",
          className,
        )}
      >
        <span aria-hidden="true" className="grid overflow-hidden text-left">
          <span className="invisible col-start-1 row-start-1 whitespace-nowrap">
            {longestPhrase}…
          </span>
          {variant === "cascade" ? (
            <CascadePhrase {...phraseProps} />
          ) : variant === "scramble" ? (
            <ScramblePhrase {...phraseProps} />
          ) : (
            <SwapPhrase {...phraseProps} />
          )}
        </span>

        <span id={statusId} className="sr-only">
          {phrase}
        </span>
      </span>
    </>
  );
}
