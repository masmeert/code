import type { Effort, PermissionLevel, ProviderKind } from "@masscode/contracts";

/** Efforts each harness can take, lowest first; a model's own list narrows it. */
export const EFFORTS: Record<ProviderKind, ReadonlyArray<Effort>> = {
  claude: ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  cursor: ["minimal", "low", "medium", "high", "xhigh", "max"],
};

export const EFFORT_LABEL: Record<Effort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
};

/**
 * Permission levels each harness offers, safest first; Codex has no plan or auto mode. Cursor edits
 * without asking, so it can't offer "ask first".
 */
export const PERMISSIONS: Record<ProviderKind, ReadonlyArray<PermissionLevel>> = {
  claude: ["plan", "ask", "auto-edit", "auto", "full-access"],
  codex: ["ask", "auto-edit", "full-access"],
  cursor: ["plan", "auto-edit", "full-access"],
};

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  plan: "Plan",
  ask: "Ask first",
  "auto-edit": "Auto-edit",
  auto: "Auto",
  "full-access": "Full access",
};

export const PERMISSION_DESCRIPTION: Record<PermissionLevel, string> = {
  plan: "Reads and plans without changing anything, then asks you to approve the plan",
  ask: "Asks before running commands or editing files",
  "auto-edit": "Edits files freely, asks before riskier commands",
  auto: "A classifier approves safe actions and blocks risky ones, without asking",
  "full-access": "Runs anything without asking, outside the sandbox too",
};
