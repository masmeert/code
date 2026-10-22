export type Side = "top" | "bottom";
export type Align = "start" | "center" | "end";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

export interface Geometry {
  layerWidth: number;
  layerHeight: number;
  left: number;
  top: number;
  trigger: Rect;
  panel: Rect;
}

interface GeometryInput {
  triggerWidth: number;
  triggerHeight: number;
  contentWidth: number;
  contentHeight: number;
  side: Side;
  align: Align;
  gap: number;
  panelRadius: number;
}

const CIRCLE_KAPPA = 0.5523;

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

export function buildGeometry({
  triggerWidth,
  triggerHeight,
  contentWidth,
  contentHeight,
  side,
  align,
  gap,
  panelRadius,
}: GeometryInput): Geometry {
  const panelY = side === "bottom" ? triggerHeight + gap : -(gap + contentHeight);
  const panelX =
    align === "start"
      ? 0
      : align === "end"
        ? triggerWidth - contentWidth
        : (triggerWidth - contentWidth) / 2;

  const left = Math.min(0, panelX);
  const top = Math.min(0, panelY);

  return {
    layerWidth: Math.max(triggerWidth, panelX + contentWidth) - left,
    layerHeight: Math.max(triggerHeight, panelY + contentHeight) - top,
    left,
    top,
    trigger: {
      x: -left,
      y: -top,
      width: triggerWidth,
      height: triggerHeight,
      radius: Math.min(triggerHeight / 2, panelRadius),
    },
    panel: {
      x: panelX - left,
      y: panelY - top,
      width: contentWidth,
      height: contentHeight,
      radius: panelRadius,
    },
  };
}

function rectAtProgress(geometry: Geometry, progress: number): Rect {
  const trigger = geometry.trigger;
  const panel = geometry.panel;

  return {
    x: lerp(trigger.x, panel.x, progress),
    y: lerp(trigger.y, panel.y, progress),
    width: lerp(trigger.width, panel.width, progress),
    height: lerp(trigger.height, panel.height, progress),
    radius: lerp(trigger.radius, panel.radius, progress),
  };
}

function insetClipPath(rect: Rect, layerWidth: number, layerHeight: number) {
  return `inset(${rect.y}px ${layerWidth - (rect.x + rect.width)}px ${layerHeight - (rect.y + rect.height)}px ${rect.x}px round ${rect.radius}px)`;
}

function roundedRectangleShape(rect: Rect) {
  const radius = Math.max(0, Math.min(rect.radius, rect.width / 2, rect.height / 2));
  const control = radius * CIRCLE_KAPPA;
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  const toPixels = (value: number) => `${value.toFixed(3)}px`;

  return (
    `shape(from ${toPixels(x1 + radius)} ${toPixels(y1)}, ` +
    `line to ${toPixels(x2 - radius)} ${toPixels(y1)}, ` +
    `curve to ${toPixels(x2)} ${toPixels(y1 + radius)} with ${toPixels(x2 - radius + control)} ${toPixels(y1)} / ${toPixels(x2)} ${toPixels(y1 + radius - control)}, ` +
    `line to ${toPixels(x2)} ${toPixels(y2 - radius)}, ` +
    `curve to ${toPixels(x2 - radius)} ${toPixels(y2)} with ${toPixels(x2)} ${toPixels(y2 - radius + control)} / ${toPixels(x2 - radius + control)} ${toPixels(y2)}, ` +
    `line to ${toPixels(x1 + radius)} ${toPixels(y2)}, ` +
    `curve to ${toPixels(x1)} ${toPixels(y2 - radius)} with ${toPixels(x1 + radius - control)} ${toPixels(y2)} / ${toPixels(x1)} ${toPixels(y2 - radius + control)}, ` +
    `line to ${toPixels(x1)} ${toPixels(y1 + radius)}, ` +
    `curve to ${toPixels(x1 + radius)} ${toPixels(y1)} with ${toPixels(x1)} ${toPixels(y1 + radius - control)} / ${toPixels(x1 + radius - control)} ${toPixels(y1)}, ` +
    "close)"
  );
}

function roundedRectanglePath(rect: Rect) {
  const radius = Math.max(0, Math.min(rect.radius, rect.width / 2, rect.height / 2));
  const toCoordinate = (value: number) => value.toFixed(3);
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  const arc = `A${toCoordinate(radius)} ${toCoordinate(radius)} 0 0 1`;

  return (
    `M${toCoordinate(x1 + radius)} ${toCoordinate(y1)}` +
    `H${toCoordinate(x2 - radius)}${arc} ${toCoordinate(x2)} ${toCoordinate(y1 + radius)}` +
    `V${toCoordinate(y2 - radius)}${arc} ${toCoordinate(x2 - radius)} ${toCoordinate(y2)}` +
    `H${toCoordinate(x1 + radius)}${arc} ${toCoordinate(x1)} ${toCoordinate(y2 - radius)}` +
    `V${toCoordinate(y1 + radius)}${arc} ${toCoordinate(x1 + radius)} ${toCoordinate(y1)}Z`
  );
}

export function clipPathAtProgress(geometry: Geometry, progress: number, supportsShape: boolean) {
  const rect = rectAtProgress(geometry, progress);
  return supportsShape
    ? roundedRectangleShape(rect)
    : insetClipPath(rect, geometry.layerWidth, geometry.layerHeight);
}

export function triggerCutoutPath(geometry: Geometry) {
  return `path(evenodd, "${roundedRectanglePath({
    x: 0,
    y: 0,
    width: geometry.layerWidth,
    height: geometry.layerHeight,
    radius: 0,
  })} ${roundedRectanglePath(geometry.trigger)}")`;
}
