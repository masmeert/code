import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconHelpCircle,
  IconLoader2,
  IconMessage2,
  IconX,
} from "@tabler/icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { AgentDisclosure } from "@masscode/ui/agents/agent-disclosure";
import { ActionSwapRollText } from "@masscode/ui/motion/action-swap-roll";
import { Button } from "@masmeert/ui/button";
import { Checkbox } from "@masmeert/ui/checkbox";
import { Input } from "@masmeert/ui/input";
import { RadioGroup, RadioGroupItem } from "@masmeert/ui/radio-group";
import { EASE_OUT } from "@masmeert/ui/lib/ease";
import { spring, springExit } from "@masmeert/ui/lib/springs";
import { cn } from "@masscode/ui/lib/utils";
import type {
  ApprovalCardAnswer,
  ApprovalCardAnswers,
  ApprovalCardProps,
  ApprovalCardQuestion,
  ApprovalCardStatus,
} from "./approval-card/types";
import { typeClass } from "@masmeert/ui/lib/type-scale";

export type {
  ApprovalCardAnswer,
  ApprovalCardAnswers,
  ApprovalCardOption,
  ApprovalCardProps,
  ApprovalCardQuestion,
  ApprovalCardStatus,
} from "./approval-card/types";

const EMPTY_ANSWER: ApprovalCardAnswer = { selected: [], custom: "" };

function getStatusLabel(status: ApprovalCardStatus) {
  if (status === "submitting") return "Submitting";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "changes-requested") return "Changes requested";
  if (status === "answered") return "Response submitted";
  if (status === "skipped") return "Skipped";
  return "Input required";
}

function getStatusClass(status: ApprovalCardStatus) {
  if (status === "approved" || status === "answered") {
    return "text-success";
  }
  if (status === "rejected") return "text-destructive";
  if (status === "changes-requested") {
    return "text-warning";
  }
  return "text-muted-foreground";
}

function getStatusBadgeClass(status: ApprovalCardStatus) {
  if (status === "pending" || status === "changes-requested") {
    return "border-warning/30 bg-warning/10 text-warning";
  }
  if (status === "submitting") {
    return "animate-pulse border-success/30 bg-success/10 text-success";
  }
  if (status === "skipped") return "border-border bg-background/60 text-muted-foreground";
  if (status === "approved" || status === "answered") {
    return "border-success/30 bg-success/10 text-success";
  }
  return "border-destructive/30 bg-destructive/10 text-destructive";
}

function isAnswered(answer: ApprovalCardAnswer) {
  return answer.selected.length > 0 || Boolean(answer.custom?.trim());
}

function QuestionOptions({
  question,
  answer,
  disabled,
  onChange,
  onSingleSelect,
}: {
  question: ApprovalCardQuestion;
  answer: ApprovalCardAnswer;
  disabled: boolean;
  onChange: (answer: ApprovalCardAnswer) => void;
  onSingleSelect?: () => void;
}) {
  const custom = answer.custom ?? "";
  const [lookedAt, setLookedAt] = useState<string>();
  const preview = question.options?.find(
    (option) => option.value === (lookedAt ?? answer.selected.at(-1)),
  )?.preview;

  return (
    <div className="mt-3">
      {question.options?.length ? (
        question.multiple ? (
          <div className="grid gap-3">
            {question.options.map((option) => (
              <div key={option.value} className="flex" onFocus={() => setLookedAt(option.value)}>
                <Checkbox
                  checked={answer.selected.includes(option.value)}
                  disabled={disabled || option.disabled}
                  label={option.label}
                  description={option.description}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...answer,
                      selected: checked
                        ? [...answer.selected, option.value]
                        : answer.selected.filter((value) => value !== option.value),
                    })
                  }
                  className="w-full"
                />
              </div>
            ))}
          </div>
        ) : (
          <RadioGroup
            value={answer.selected[0] ?? ""}
            onValueChange={(value) => {
              onChange({ selected: [value], custom: "" });
              onSingleSelect?.();
            }}
          >
            {question.options.map((option) => (
              <div key={option.value} className="flex" onFocus={() => setLookedAt(option.value)}>
                <RadioGroupItem
                  value={option.value}
                  label={option.label}
                  description={option.description}
                  disabled={disabled || option.disabled}
                  // Unpadded and full width: the kit pads the highlight past each row itself.
                  className="w-full"
                />
              </div>
            ))}
          </RadioGroup>
        )
      ) : null}

      {preview ? <div className="mt-2 max-h-72 overflow-auto rounded-xl">{preview}</div> : null}

      {question.allowCustom ? (
        <Input
          value={custom}
          disabled={disabled}
          placeholder={question.customPlaceholder ?? "Add another response…"}
          onChange={(value) =>
            onChange({
              selected: question.multiple ? answer.selected : [],
              custom: value,
            })
          }
          className={cn("p-0.5", question.options?.length && "mt-1.5")}
          classNames={{
            field: "h-10 rounded-xl border-0 bg-background/70 focus-within:bg-background",
            input: cn(typeClass("body"), "px-3"),
          }}
        />
      ) : null}
    </div>
  );
}

function ProgressDots({ current, ids }: { current: number; ids: string[] }) {
  return (
    <span className="flex gap-1.5">
      <span className="sr-only">
        Question {current + 1} of {ids.length}
      </span>
      {ids.map((id, index) => (
        <motion.span
          key={id}
          aria-hidden="true"
          initial={{
            scale: index === current ? 1 : 0.75,
            opacity: index <= current ? 1 : 0.35,
          }}
          animate={{
            scale: index === current ? 1 : 0.75,
            opacity: index <= current ? 1 : 0.35,
          }}
          transition={spring.fast}
          className="size-1.5 rounded-full bg-foreground"
        />
      ))}
    </span>
  );
}

export function ApprovalCard({
  title = "Approval required",
  description,
  children,
  questions = [],
  status = "pending",
  answers,
  defaultAnswers = {},
  onAnswersChange,
  step,
  defaultStep = 0,
  onStepChange,
  onSubmit,
  onApprove,
  onReject,
  onRequestChanges,
  onDismiss,
  approveLabel = "Approve",
  submitLabel = "Submit response",
  result,
  autoFocus = false,
  className,
}: ApprovalCardProps) {
  const reduce = useReducedMotion() ?? false;
  const [internalAnswers, setInternalAnswers] = useState<ApprovalCardAnswers>(defaultAnswers);
  const [internalStep, setInternalStep] = useState(defaultStep);
  const autoAdvanceTimer = useRef<number | undefined>(undefined);
  const cardRef = useRef<HTMLDivElement>(null);
  const currentAnswers = answers ?? internalAnswers;
  const currentStep = Math.min(
    Math.max(0, step ?? internalStep),
    Math.max(0, questions.length - 1),
  );
  const question = questions[currentStep];
  const questionMode = questions.length > 0;
  const multipleQuestions = questions.length > 1;
  const pending = status === "pending";
  const busy = status === "submitting";
  const interactive = pending || busy;
  const currentAnswer = question ? (currentAnswers[question.id] ?? EMPTY_ANSWER) : EMPTY_ANSWER;
  const displayTitle = question?.title ?? title;
  const titleKey = question?.id ?? String(status);
  const statusLabel = getStatusLabel(status);

  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimer.current === undefined) return;
    window.clearTimeout(autoAdvanceTimer.current);
    autoAdvanceTimer.current = undefined;
  }, []);

  useEffect(() => clearAutoAdvance, [clearAutoAdvance]);

  // Decided at mount only: a card shouldn't grab focus later, while you're typing elsewhere.
  const focusOnMount = useRef(autoFocus && questionMode && pending);
  useEffect(() => {
    if (focusOnMount.current) cardRef.current?.focus({ preventScroll: true });
  }, []);

  const setAnswers = useCallback(
    (next: ApprovalCardAnswers) => {
      if (answers === undefined) setInternalAnswers(next);
      onAnswersChange?.(next);
    },
    [answers, onAnswersChange],
  );

  const setStep = (next: number) => {
    clearAutoAdvance();
    if (step === undefined) setInternalStep(next);
    onStepChange?.(next);
  };

  const updateCurrentAnswer = (next: ApprovalCardAnswer) => {
    if (!question) return;
    setAnswers({ ...currentAnswers, [question.id]: next });
  };

  const continueQuestion = () => {
    if (currentStep < questions.length - 1) {
      setStep(currentStep + 1);
      return;
    }
    onSubmit?.(currentAnswers);
  };

  const queueAutoAdvance = () => {
    if (
      !question ||
      question.multiple ||
      question.autoAdvance === false ||
      currentStep >= questions.length - 1 ||
      busy
    ) {
      return;
    }

    clearAutoAdvance();
    autoAdvanceTimer.current = window.setTimeout(() => {
      setStep(currentStep + 1);
    }, 240);
  };

  const answerWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!question || !pending || event.metaKey || event.ctrlKey || event.altKey) return;
    const typing =
      event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // Esc in the text field only leaves it; the keys then answer again.
      if (typing) cardRef.current?.focus();
      else onDismiss?.();
      return;
    }
    // A focused option or button does its own thing on Enter.
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      if (!isAnswered(currentAnswer)) return;
      event.preventDefault();
      continueQuestion();
      return;
    }
    if (typing) return;
    if (event.key === "ArrowLeft" && currentStep > 0) {
      event.preventDefault();
      setStep(currentStep - 1);
      return;
    }
    if (
      event.key === "ArrowRight" &&
      currentStep < questions.length - 1 &&
      isAnswered(currentAnswer)
    ) {
      event.preventDefault();
      setStep(currentStep + 1);
      return;
    }
    const option = /^[1-9]$/.test(event.key)
      ? question.options?.[Number(event.key) - 1]
      : undefined;
    if (!option || option.disabled) return;
    event.preventDefault();
    if (!question.multiple) {
      updateCurrentAnswer({ selected: [option.value], custom: "" });
      queueAutoAdvance();
    } else if (currentAnswer.selected.includes(option.value))
      updateCurrentAnswer({
        ...currentAnswer,
        selected: currentAnswer.selected.filter((value) => value !== option.value),
      });
    else
      updateCurrentAnswer({
        ...currentAnswer,
        selected: [...currentAnswer.selected, option.value],
      });
  };

  return (
    <div
      ref={cardRef}
      data-state={status}
      aria-busy={busy}
      tabIndex={questionMode && pending ? -1 : undefined}
      onKeyDown={answerWithKeys}
      className={cn(
        typeClass("body"),
        "group/approval w-full overflow-hidden rounded-2xl bg-muted p-4 outline-none",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-5 shrink-0 place-items-center text-muted-foreground",
            getStatusClass(status),
          )}
        >
          {busy ? (
            <IconLoader2 className={cn("size-4", !reduce && "animate-spin")} />
          ) : interactive ? (
            questionMode ? (
              <IconHelpCircle className="size-4" />
            ) : (
              <IconMessage2 className="size-4" />
            )
          ) : status === "rejected" || status === "skipped" ? (
            <IconX className="size-4" />
          ) : (
            <IconCheck className="size-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-3">
            <h3
              className={cn(
                typeClass("subtitle"),
                "min-w-0 flex-1 leading-5 font-medium text-foreground",
              )}
            >
              <ActionSwapRollText value={titleKey}>{displayTitle}</ActionSwapRollText>
            </h3>
            {questionMode && interactive ? (
              multipleQuestions ? (
                <span
                  className={cn(
                    typeClass("caption"),
                    "shrink-0 text-muted-foreground tabular-nums",
                  )}
                >
                  {currentStep + 1}/{questions.length}
                </span>
              ) : null
            ) : (
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                  getStatusBadgeClass(status),
                )}
              >
                {statusLabel}
              </span>
            )}
            {onDismiss ? (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={onDismiss}
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring"
              >
                <IconX className="size-4" />
              </button>
            ) : null}
          </div>

          {/* Room on the sides: the radio highlight reaches 8px past its rows, and this clips. */}
          <AgentDisclosure open={interactive} className="-mx-2 px-2">
            {questionMode && question ? (
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  key={question.id}
                  initial={reduce ? { opacity: 1 } : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={
                    reduce ? { opacity: 0 } : { opacity: 0, x: -6, transition: springExit.moderate }
                  }
                  transition={{ duration: reduce ? 0 : 0.2, ease: EASE_OUT }}
                >
                  {question.description ? (
                    <p className="mt-1 leading-5 text-muted-foreground">{question.description}</p>
                  ) : null}
                  <QuestionOptions
                    question={question}
                    answer={currentAnswer}
                    disabled={busy}
                    onChange={updateCurrentAnswer}
                    onSingleSelect={queueAutoAdvance}
                  />
                </motion.div>
              </AnimatePresence>
            ) : (
              <div>
                {description ? (
                  <p className="mt-1 leading-5 text-muted-foreground">{description}</p>
                ) : null}
                {children ? <div className="mt-3">{children}</div> : null}
              </div>
            )}

            {questionMode ? (
              <div className="mt-4 flex items-center gap-3">
                {multipleQuestions ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Previous question"
                      disabled={busy || currentStep === 0}
                      onClick={() => setStep(currentStep - 1)}
                      className="rounded-full"
                    >
                      <IconArrowLeft className="size-4" />
                    </Button>
                    <ProgressDots current={currentStep} ids={questions.map((item) => item.id)} />
                  </>
                ) : null}
                {pending ? (
                  <span
                    className={cn(
                      typeClass("caption"),
                      "hidden min-w-0 truncate text-muted-foreground group-focus-within/approval:inline",
                    )}
                  >
                    {question?.options?.length
                      ? `1–${Math.min(question.options.length, 9)} to pick, `
                      : ""}
                    ↵ to continue{onDismiss ? ", Esc to skip" : ""}
                  </span>
                ) : null}
                <Button
                  size={currentStep === questions.length - 1 ? "compact" : "icon"}
                  aria-label={
                    currentStep === questions.length - 1 ? "Submit response" : "Next question"
                  }
                  disabled={busy || !isAnswered(currentAnswer)}
                  onClick={continueQuestion}
                  className="ml-auto shrink-0 rounded-full"
                >
                  {busy ? (
                    <IconLoader2 className={cn("size-4", !reduce && "animate-spin")} />
                  ) : currentStep === questions.length - 1 ? (
                    <>
                      {submitLabel}
                      <IconArrowRight className="size-3.5" />
                    </>
                  ) : (
                    <IconArrowRight className="size-4" />
                  )}
                </Button>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="compact" disabled={busy} onClick={onApprove} className="rounded-full">
                  {approveLabel}
                </Button>
                {onRequestChanges ? (
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={busy}
                    onClick={onRequestChanges}
                    className="rounded-full"
                  >
                    Request changes
                  </Button>
                ) : null}
                {onReject ? (
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={busy}
                    onClick={onReject}
                    className="rounded-full text-muted-foreground hover:text-destructive"
                  >
                    Reject
                  </Button>
                ) : null}
              </div>
            )}
          </AgentDisclosure>

          {!interactive ? (
            <p className={cn(typeClass("body"), "mt-1 text-muted-foreground")}>
              {result ?? statusLabel}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
