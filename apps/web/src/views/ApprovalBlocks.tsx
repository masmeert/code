import { ApprovalCard } from "@masscode/ui/agents/approval-card";
import { Markdown } from "@masscode/ui/agents/markdown";
import { ToolApproval, ToolApprovalCode } from "@masscode/ui/agents/tool-approval";
import { ScrollArea } from "@masscode/ui/components/scroll-area";
import type { UserQuestion } from "@masscode/contracts";
import { useState } from "react";
import {
  approvePlan,
  BUILD_WITH_LABEL,
  PERMISSIONS,
  useNeedsRootConsent,
} from "../lib/composer.ts";
import { getDraft } from "../lib/drafts.ts";
import { respondApproval, useStore, useThreadHost, type TranscriptItem } from "../lib/store.ts";
import { RootFullAccessDialog } from "./Composer.tsx";

type ApprovalItem = Extract<TranscriptItem, { kind: "approval" }>;

function getPlanStatus(plan: ApprovalItem) {
  if (plan.decision === "deny") return "denied";

  if (!plan.decision) return "pending";

  return plan.resolved ? "approved" : "approving";
}

/** The agent's plan, to build with a permission level of your choosing or reject. */
export function PlanApproval({ threadId, item }: { threadId: string; item: ApprovalItem }) {
  const host = useThreadHost(threadId);
  const needsRootConsent = useNeedsRootConsent(host);
  const provider = useStore((state) => state.threads[threadId]?.provider);
  const [isConfirmingRoot, setIsConfirmingRoot] = useState(false);

  // Interrupted before an answer: the turn ended, so there's nothing left to approve.
  if (item.resolved && !item.decision) return null;

  return (
    <>
      <ToolApproval
        title="Approve this plan?"
        description={item.decision === "deny" ? "Rejected — say what to change" : undefined}
        status={getPlanStatus(item)}
        defaultOpen
        approveLabel={BUILD_WITH_LABEL["auto-edit"]}
        approveOptions={(["ask", "auto-edit", "auto", "full-access"] as const).flatMap((level) =>
          provider !== undefined && !PERMISSIONS[provider].includes(level)
            ? []
            : [
                {
                  id: level,
                  label: BUILD_WITH_LABEL[level],
                  onSelect: () =>
                    level === "full-access" && needsRootConsent
                      ? setIsConfirmingRoot(true)
                      : approvePlan(threadId, item.id, level),
                },
              ],
        )}
        denyLabel="Reject"
        onApprove={() => approvePlan(threadId, item.id, "auto-edit")}
        onDeny={() => respondApproval(threadId, item.id, "deny")}
      >
        {/* Radix wraps content in display:table, which lets wide code blocks stretch past the card. */}
        <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:max-h-96 [&>[data-slot=scroll-area-viewport]>div]:!block">
          <Markdown className="selectable pr-3 leading-relaxed">{item.detail}</Markdown>
        </ScrollArea>
      </ToolApproval>
      {isConfirmingRoot && host ? (
        <RootFullAccessDialog
          host={host}
          onAllow={() => approvePlan(threadId, item.id, "full-access")}
          onClose={() => setIsConfirmingRoot(false)}
        />
      ) : null}
    </>
  );
}

/** Multiple-choice questions from the agent, answered in place. */
export function QuestionsApproval({
  threadId,
  item,
  questions,
}: {
  threadId: string;
  item: ApprovalItem;
  questions: ReadonlyArray<UserQuestion>;
}) {
  const { answers } = item;

  return (
    <ApprovalCard
      autoFocus={
        !getDraft(threadId).text.trim() &&
        (document.activeElement === document.body ||
          document.activeElement?.matches("textarea[data-composer]") === true)
      }
      status={
        item.resolved
          ? answers
            ? "answered"
            : "skipped"
          : item.decision
            ? "submitting"
            : "pending"
      }
      questions={questions.map((question) => ({
        id: question.id,
        title: question.question,
        description: item.agent ? `Asked by ${item.agent}` : undefined,
        options: question.options.map((option) => {
          const choice = {
            value: option.label,
            label: option.label,
            description: option.description,
          };

          return option.preview === undefined
            ? choice
            : {
                ...choice,
                preview: (
                  <pre className="bg-muted/50 p-3 font-mono text-xs leading-relaxed">
                    {option.preview}
                  </pre>
                ),
              };
        }),
        multiple: question.multiSelect,
        allowCustom: true,
        customPlaceholder: "Something else…",
      }))}
      onSubmit={(chosen) =>
        respondApproval(threadId, item.id, "allow", {
          answers: Object.fromEntries(
            questions.map((question) => {
              const custom = chosen[question.id]?.custom?.trim();

              return [
                question.id,
                [...(chosen[question.id]?.selected ?? []), ...(custom ? [custom] : [])],
              ];
            }),
          ),
        })
      }
      onDismiss={
        item.resolved || item.decision
          ? undefined
          : () => respondApproval(threadId, item.id, "deny")
      }
      result={
        answers
          ? questions
              .map(
                (question) =>
                  `${questions.length > 1 ? `${question.header}: ` : ""}${(answers[question.id] ?? []).join(", ")}`,
              )
              .join("; ")
          : "Went on without an answer"
      }
    />
  );
}

/** A tool call waiting for permission to run. */
export function ToolApprovalRequest({ threadId, item }: { threadId: string; item: ApprovalItem }) {
  // Once approved, the tool group shows what ran; only pending and denied requests stay visible.
  if (item.resolved && item.decision !== "deny") return null;

  return (
    <ToolApproval
      tool={item.title}
      title={`Allow ${item.title}${item.agent ? ` for ${item.agent}` : ""}?`}
      status={item.decision === "deny" ? "denied" : item.decision ? "approving" : "pending"}
      defaultOpen
      parameters={[
        {
          id: "input",
          label: "Input",
          value: <ToolApprovalCode code={item.detail} language="bash" />,
        },
      ]}
      onApprove={() => respondApproval(threadId, item.id, "allow")}
      onAlwaysAllow={() => respondApproval(threadId, item.id, "allow-session")}
      onDeny={() => respondApproval(threadId, item.id, "deny")}
    />
  );
}
