import type { DeviceHub, DevicePlatform } from "@masscode/contracts";

/**
 * A live simulator or emulator screen from the device hub, with touches and keys sent back.
 * Ported from t3code's device stream client (MIT), without its Duo and remote-access parts.
 *
 * - iOS (serve-sim): H.264 in an HTTP `stream.avcc` body of `u32be length, u8 tag, payload`
 *   envelopes (1 avcC description, 2 keyframe, 3 delta, 4 JPEG seed), decoded with WebCodecs;
 *   input and the screen config go over `helper/ws` as `[tag][json]` packets. Falls back to
 *   the MJPEG endpoint when the H.264 profile can't be decoded.
 * - Android (serve-emu): one socket carries H.264 access units behind a 16-byte "SEMU" header
 *   and takes JSON gestures.
 */

export type StreamStatus = "connecting" | "streaming";

export type Orientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

export interface DeviceStream {
  readonly stop: () => void;
  /** 0..1 within the displayed screen. */
  readonly touch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  readonly key: (event: KeyboardEvent, phase: "down" | "up") => void;
  readonly press: (button: "home" | "back") => void;
  /** A quarter turn clockwise; iOS only. */
  readonly rotate: () => void;
}

interface StreamEvents {
  readonly onStatus: (status: StreamStatus) => void;
  /** iOS can't decode the H.264 stream here; show this MJPEG URL in an `<img>` instead. */
  readonly onMjpeg: (url: string) => void;
}

interface ScreenConfig {
  readonly width: number;
  readonly height: number;
  readonly orientation: Orientation;
}

const RETRY_MS = 1000;
/** A stream body can stay open after the device stops sending frames. */
const STALL_MS = 15_000;
const FRAME_DURATION_US = 16_667;
const MAX_DECODE_QUEUE = 8;
const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER_BYTES = 16;

// serve-sim socket tags, browser to helper, then helper to browser.
const IOS_TOUCH = 0x03;
const IOS_BUTTON = 0x04;
const IOS_KEY = 0x06;
const IOS_ORIENTATION = 0x07;
const IOS_SCREEN_CONFIG = 0x82;

const ORIENTATIONS: ReadonlyArray<Orientation> = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
];

/** Clockwise quarter turns from the raw framebuffer to what the user sees. */
const QUARTER_TURNS: Record<Orientation, number> = {
  portrait: 0,
  landscape_left: 1,
  portrait_upside_down: 2,
  landscape_right: 3,
};

const ANDROID_TOUCH_ACTION = { begin: "down", move: "move", end: "up" } as const;

/** A point on the turned screen back on the raw framebuffer, by clockwise quarter turns. */
const RAW_POINT: ReadonlyArray<(x: number, y: number) => readonly [number, number]> = [
  (x, y) => [x, y],
  (x, y) => [y, 1 - x],
  (x, y) => [1 - x, 1 - y],
  (x, y) => [1 - y, x],
];

const HID_USAGE_BY_CODE = new Map([
  ["Enter", 0x28],
  ["Escape", 0x29],
  ["Backspace", 0x2a],
  ["Tab", 0x2b],
  ["Space", 0x2c],
  ["Minus", 0x2d],
  ["Equal", 0x2e],
  ["BracketLeft", 0x2f],
  ["BracketRight", 0x30],
  ["Backslash", 0x31],
  ["Semicolon", 0x33],
  ["Quote", 0x34],
  ["Backquote", 0x35],
  ["Comma", 0x36],
  ["Period", 0x37],
  ["Slash", 0x38],
  ["Delete", 0x4c],
  ["ArrowRight", 0x4f],
  ["ArrowLeft", 0x50],
  ["ArrowDown", 0x51],
  ["ArrowUp", 0x52],
  ["ControlLeft", 0xe0],
  ["ShiftLeft", 0xe1],
  ["AltLeft", 0xe2],
  ["ControlRight", 0xe4],
  ["ShiftRight", 0xe5],
  ["AltRight", 0xe6],
]);

const ANDROID_KEYCODE_BY_KEY = new Map([
  ["ArrowUp", 19],
  ["ArrowDown", 20],
  ["ArrowLeft", 21],
  ["ArrowRight", 22],
  ["Tab", 61],
  ["Enter", 66],
  ["Backspace", 67],
  ["Delete", 112],
]);

function hidUsage(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + code.charCodeAt(3) - 65;
  if (/^Digit[1-9]$/.test(code)) return 0x1e + code.charCodeAt(5) - 49;
  if (code === "Digit0") return 0x27;
  return HID_USAGE_BY_CODE.get(code) ?? null;
}

/** What serve-sim's socket takes: a touch, a button, a key or an orientation. */
type IosInput =
  | { readonly type: "begin" | "move" | "end"; readonly x: number; readonly y: number }
  | { readonly button: "home" }
  | { readonly type: "down" | "up"; readonly usage: number }
  | { readonly orientation: Orientation };

function taggedJson(tag: number, payload: IosInput) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const message = new Uint8Array(1 + json.length);
  message[0] = tag;
  message.set(json, 1);
  return message;
}

/** The WebCodecs `avc1.PPCCLL` codec string from an avcC record or an SPS NAL unit. */
function avcCodec(bytes: Uint8Array) {
  if (bytes.length < 4) return "avc1.42E01E";
  return `avc1.${[bytes[1]!, bytes[2]!, bytes[3]!].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether an Annex-B access unit holds a keyframe, and its SPS if it has one. */
function scanAccessUnit(buffer: Uint8Array) {
  let isKey = false;
  let sps: Uint8Array | null = null;
  for (let index = 0; index + 2 < buffer.length; index++) {
    if (buffer[index] !== 0 || buffer[index + 1] !== 0) continue;
    const startCode =
      buffer[index + 2] === 1 ? 3 : buffer[index + 2] === 0 && buffer[index + 3] === 1 ? 4 : 0;
    if (!startCode) continue;
    const nalType = buffer[index + startCode]! & 0x1f;
    if (nalType === 7) sps ??= buffer.subarray(index + startCode);
    if (nalType === 5) isKey = true;
    index += startCode;
  }
  return { isKey, sps };
}

/** Splits a fragmented AVCC body into whole `[tag, payload]` envelopes. */
function avccDemuxer() {
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(64 * 1024);
  let length = 0;
  return (bytes: Uint8Array) => {
    if (length + bytes.length > buffer.length) {
      const grown = new Uint8Array(Math.max(buffer.length * 2, length + bytes.length));
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(bytes, length);
    length += bytes.length;
    const envelopes: Array<{ readonly tag: number; readonly payload: Uint8Array<ArrayBuffer> }> =
      [];
    let offset = 0;
    while (length - offset >= 4) {
      const size = new DataView(buffer.buffer, offset, 4).getUint32(0);
      if (length - offset - 4 < size) break;
      if (size >= 1)
        envelopes.push({
          tag: buffer[offset + 4]!,
          payload: buffer.slice(offset + 5, offset + 4 + size),
        });
      offset += 4 + size;
    }
    buffer.copyWithin(0, offset, length);
    length -= offset;
    return envelopes;
  };
}

export function connectDeviceStream(
  hub: DeviceHub,
  platform: DevicePlatform,
  streamId: string,
  canvas: HTMLCanvasElement,
  events: StreamEvents,
): DeviceStream {
  const vendor = `${hub.origin}/vendor/${platform === "ios" ? "serve-sim" : "serve-emu"}`;
  const wsVendor = vendor.replace(/^http/, "ws");
  const device = encodeURIComponent(streamId);
  const mjpegUrl = `${vendor}/helper/${device}/stream.mjpeg?token=${hub.token}`;
  const context = canvas.getContext("2d");
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let socket: WebSocket | null = null;
  let video: AbortController | null = null;
  let decoder: VideoDecoder | null = null;
  let awaitingKeyframe = true;
  let timestamp = 0;
  let screen: ScreenConfig | null = null;
  let mjpeg = false;
  let streaming = false;

  function later(run: () => void, delayMs: number) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) run();
    }, delayMs);
    timers.add(timer);
    return timer;
  }

  function cancel(timer: ReturnType<typeof setTimeout>) {
    clearTimeout(timer);
    timers.delete(timer);
  }

  function setStreaming(next: boolean) {
    if (stopped || streaming === next) return;
    streaming = next;
    events.onStatus(next ? "streaming" : "connecting");
  }

  /** serve-sim streams the raw framebuffer, portrait even when the device lies on its side. */
  function quarterTurns() {
    if (platform !== "ios" || !screen || screen.width > screen.height) return 0;
    return QUARTER_TURNS[screen.orientation];
  }

  function paint(source: CanvasImageSource, width: number, height: number) {
    if (stopped || !context) return;
    const turns = quarterTurns();
    const [canvasWidth, canvasHeight] = turns % 2 ? [height, width] : [width, height];
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
    context.setTransform(1, 0, 0, 1, 0, 0);
    if (turns === 1) context.setTransform(0, 1, -1, 0, canvasWidth, 0);
    if (turns === 2) context.setTransform(-1, 0, 0, -1, canvasWidth, canvasHeight);
    if (turns === 3) context.setTransform(0, -1, 1, 0, 0, canvasHeight);
    context.drawImage(source, 0, 0, width, height);
    setStreaming(true);
  }

  function closeDecoder() {
    if (decoder?.state !== "closed") decoder?.close();
    decoder = null;
    awaitingKeyframe = true;
  }

  async function configure(config: VideoDecoderConfig) {
    const full = { ...config, optimizeForLatency: true };
    const { supported } = await VideoDecoder.isConfigSupported(full).catch(() => ({
      supported: false,
    }));
    if (!supported || stopped) return false;
    if (!decoder || decoder.state === "closed") {
      const current = new VideoDecoder({
        output: (frame) => {
          if (decoder === current) paint(frame, frame.displayWidth, frame.displayHeight);
          frame.close();
        },
        error: () => {
          if (decoder === current) recover();
        },
      });
      decoder = current;
    }
    decoder.configure(full);
    return true;
  }

  function decode(isKey: boolean, data: Uint8Array, pts: number | null = null) {
    if (decoder?.state !== "configured") return;
    if (awaitingKeyframe && !isKey) return;
    awaitingKeyframe = false;
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) return recover();
    decoder.decode(
      new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: pts ?? timestamp, data }),
    );
    timestamp += FRAME_DURATION_US;
  }

  /** A decoder that falls behind or breaks: iOS shows MJPEG instead, Android asks for a keyframe. */
  function recover() {
    closeDecoder();
    if (platform === "ios") return showMjpeg();
    setStreaming(false);
    socket?.send(JSON.stringify({ type: "reset-video", ack: false }));
  }

  function showMjpeg() {
    if (mjpeg || stopped) return;
    mjpeg = true;
    video?.abort();
    closeDecoder();
    events.onMjpeg(mjpegUrl);
  }

  async function readIosVideo() {
    const controller = new AbortController();
    video = controller;
    const demux = avccDemuxer();
    try {
      const response = await fetch(`${vendor}/helper/${device}/stream.avcc?token=${hub.token}`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        const stall = later(() => controller.abort(), STALL_MS);
        const { done, value } = await reader.read().finally(() => cancel(stall));
        if (done || stopped || mjpeg) break;
        for (const { tag, payload } of demux(value)) {
          if (tag === 1) {
            awaitingKeyframe = true;
            if (!(await configure({ codec: avcCodec(payload), description: payload })))
              return showMjpeg();
          } else if (tag === 2 || tag === 3) decode(tag === 2, payload);
          else if (tag === 4)
            void createImageBitmap(new Blob([payload], { type: "image/jpeg" })).then((bitmap) => {
              paint(bitmap, bitmap.width, bitmap.height);
              bitmap.close();
            });
        }
      }
    } catch {
      // Retried below, unless stopped.
    }
    if (stopped || mjpeg || video !== controller) return;
    closeDecoder();
    setStreaming(false);
    later(() => void readIosVideo(), RETRY_MS);
  }

  /**
   * serve-sim's helper only takes input and sends its screen config once capture runs, and
   * the H.264 stream doesn't reliably start it; one aborted MJPEG request does.
   */
  async function primeIosHelper() {
    const controller = new AbortController();
    const timeout = later(() => controller.abort(), 2000);
    try {
      const response = await fetch(mjpegUrl, { signal: controller.signal });
      await response.body?.getReader().read();
    } catch {
      // The socket retries if the helper isn't up yet.
    }
    cancel(timeout);
    controller.abort();
  }

  async function connectIosInput() {
    await primeIosHelper();
    if (stopped) return;
    // The hub takes its token as a subprotocol, since a browser can't set WebSocket headers.
    const ws = new WebSocket(`${wsVendor}/helper/ws?device=${device}`, [
      `serve-sim.token.${hub.token}`,
    ]);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes[0] !== IOS_SCREEN_CONFIG) return;
      try {
        // SAFETY: serve-sim's screen config, as of the pinned hub.
        screen = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as ScreenConfig;
      } catch {
        // A malformed config keeps the last one.
      }
    };
    ws.onclose = () => {
      if (socket === ws) later(() => void connectIosInput(), RETRY_MS);
    };
  }

  function connectAndroid() {
    const ws = new WebSocket(`${wsVendor}/ws?device=${device}&frame-meta=1`, [
      `serve-sim.token.${hub.token}`,
    ]);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let configuring = false;
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // The encoder restarts at a new size when the device rotates; the next keyframe's SPS
        // configures a fresh decoder.
        if (event.data.includes('"video-session"')) {
          closeDecoder();
          setStreaming(false);
          ws.send(JSON.stringify({ type: "reset-video", ack: false }));
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const raw = event.data;
      const header = new DataView(raw, 0, Math.min(SEMU_HEADER_BYTES, raw.byteLength));
      const framed =
        raw.byteLength > SEMU_HEADER_BYTES &&
        header.getUint32(0) === SEMU_MAGIC &&
        header.getUint8(4) === 1;
      const data = new Uint8Array(raw, framed ? SEMU_HEADER_BYTES : 0);
      const pts = framed ? Number(header.getBigUint64(8)) : null;
      const configured = decoder?.state === "configured";
      const scanned = !framed || !configured ? scanAccessUnit(data) : null;
      const isKey = framed ? (header.getUint8(5) & 1) === 1 : (scanned?.isKey ?? false);
      if (!configured) {
        if (!scanned?.sps) return ws.send(JSON.stringify({ type: "reset-video", ack: false }));
        if (configuring) return;
        configuring = true;
        void configure({ codec: avcCodec(scanned.sps) }).then(() => {
          configuring = false;
          awaitingKeyframe = true;
          ws.send(JSON.stringify({ type: "reset-video", ack: false }));
        });
        return;
      }
      decode(isKey, data, pts);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      closeDecoder();
      setStreaming(false);
      later(connectAndroid, RETRY_MS);
    };
  }

  function send(message: Uint8Array<ArrayBuffer> | string) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(message);
  }

  if (platform === "android") connectAndroid();
  else {
    void connectIosInput();
    if ("VideoDecoder" in window) void readIosVideo();
    else showMjpeg();
  }

  return {
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      video?.abort();
      const current = socket;
      socket = null;
      current?.close();
      closeDecoder();
    },
    touch(phase, x, y) {
      if (platform === "android")
        return send(
          JSON.stringify({
            type: "touch",
            action: ANDROID_TOUCH_ACTION[phase],
            x,
            y,
          }),
        );
      // Back from what the user sees to the raw framebuffer, undoing `paint`'s turns.
      const [rawX, rawY] = RAW_POINT[mjpeg ? 0 : quarterTurns()]!(x, y);
      send(taggedJson(IOS_TOUCH, { type: phase, x: rawX, y: rawY }));
    },
    key(event, phase) {
      if (platform === "ios") {
        const usage = hidUsage(event.code);
        if (usage !== null) send(taggedJson(IOS_KEY, { type: phase, usage }));
        return;
      }
      if (phase !== "down") return;
      if (event.key === "Escape") return send(JSON.stringify({ type: "back" }));
      const keycode = ANDROID_KEYCODE_BY_KEY.get(event.key);
      if (keycode !== undefined) send(JSON.stringify({ type: "key", keycode }));
      else if (event.key.length === 1) send(JSON.stringify({ type: "text", text: event.key }));
    },
    press(button) {
      if (platform === "android") send(JSON.stringify({ type: button }));
      else if (button === "home") send(taggedJson(IOS_BUTTON, { button: "home" }));
    },
    rotate() {
      if (platform !== "ios") return;
      const next = ORIENTATIONS[(ORIENTATIONS.indexOf(screen?.orientation ?? "portrait") + 1) % 4]!;
      send(taggedJson(IOS_ORIENTATION, { orientation: next }));
    },
  };
}
