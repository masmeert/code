// Shared with the thread's placeholder for the lazily loaded panel, so it holds the panel's width.
export const DIFF_PANEL_WIDTH_KEY = "masscode.diffPanelWidth";

export function getDefaultDiffPanelWidth() {
  return Math.min(960, Math.round(window.innerWidth * 0.45));
}
