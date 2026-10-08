import { useEffect, useRef, useState } from "react";
import { cn } from "@apcode/ui/lib/utils";

/**
 * A WebGL2 orb: a lit sphere with colour marbling inside it. Ported from SmoothUI's Orb
 * (github.com/educlopez/smoothui, packages/smoothui/components/orb).
 *
 * The loop is seamless by construction: every point walks its own circle in a flow field whose
 * angle advances one full turn per loop, so the displacement returns to where it started. Colour is
 * mixed in OkLab, so the midpoint between two stops stays clean instead of going muddy through sRGB.
 *
 * Contains two public-domain pieces of prior art, marked at their definitions: the MurmurHash3
 * finalizer (Austin Appleby) and the OkLab transform matrices (Björn Ottosson).
 */

/** SmoothUI's tuned look, keyed by the shader uniform each value drives. */
const SURFACE_UNIFORMS = {
  /** Rim dispersion: the palette lookup splits per channel toward the edge, like a lens fringe. */
  uAberr: 0.8,
  /** Which stop dominates. 1 is even; above favours the first stop. */
  uBalance: 1,
  /** Hue ripple through the palette. */
  uChroma: 1,
  uContrast: 1,
  /** How far the flow field carries the field over a loop. */
  uFlow: 0.6,
  /** Halo outside the silhouette. */
  uGlow: 0,
  /** Film grain, which also hides the banding of large soft gradients. */
  uGrain: 0.6,
  /** Internal scatter offset away from the highlight: fake subsurface. */
  uInner: 0.38,
  /** Fresnel-driven hue rotation: thin-film sheen. */
  uIrid: 0,
  /** Bends the noise lookup by the surface normal. */
  uRefract: 0.25,
  /** Fresnel edge brightness, which is what reads as glass. */
  uRim: 1.3,
  /** Interior cell frequency, the inverse of blob size: low is one slow swell. */
  uScaleN: 1.45 / 3,
  /** Blends the palette toward plain diffuse shading. */
  uShading: 0.05,
  /** Rotates the palette. */
  uShift: 0.23,
  /** Edge feather. 0 still resolves to about 1.5 device pixels. */
  uSoft: 0.005,
  uSpec: 0.2,
  /** Strength of the nested warp: marbling rather than blobs. */
  uTurb: 0.4,
  /** Silhouette deformation, so the orb is a drop rather than a ball. */
  uWobble: 0,
};

const MAX_STOPS = 4;
const LOOP_SECONDS = 7;
/** Ambient motion gains nothing from 120 Hz. */
const FRAME_CAP_MS = 1000 / 60;
const TAU = Math.PI * 2;

/* The covering triangle is built from gl_VertexID, so there is no vertex
   buffer and no attribute state to manage. */
const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;   // the hash needs full 32-bit ints

uniform vec2  uRes;
uniform float uPhase;
uniform vec3  uLab[4];
uniform float uCount;
uniform float uScaleN;
uniform float uFlow;
uniform float uTurb;
uniform float uShift;
uniform float uBalance;
uniform float uChroma;
uniform float uContrast;
uniform float uRim;
uniform float uSpec;
uniform float uInner;
uniform float uShading;
uniform float uRefract;
uniform float uIrid;
uniform float uAberr;
uniform float uGrain;
uniform float uSoft;
uniform float uWobble;
uniform float uGlow;
uniform vec3  uLight;

out vec4 fragColor;

const float TAU = 6.28318530718;
const float RAD = 0.86;         // sphere radius in uv units; the rest is glow room
const float RMAX = 1.0 / RAD;   // radius reached at the nearest canvas edge

/* MurmurHash3 finalizer, Austin Appleby, public domain. Exact at any lattice
   coordinate, so unlike a fract(sin(...)) hash it never bands as the input
   grows — which matters for the grain, whose input runs into the thousands. */
uint hashU(uint x) {
  x ^= x >> 16; x *= 0x85EBCA6Bu;
  x ^= x >> 13; x *= 0xC2B2AE35u;
  x ^= x >> 16;
  return x;
}
uint hashU2(uvec2 p) { return hashU(p.x * 0x9E3779B9u ^ hashU(p.y)); }
uint hashU3(uvec3 p) { return hashU(p.x * 0x9E3779B9u ^ hashU(p.y) ^ hashU(p.z) * 0x27D4EB2Fu); }
float rand2(ivec2 p) { return float(hashU2(uvec2(p + 4096)) >> 8) / 16777216.0; }
float rand3(ivec3 p) { return float(hashU3(uvec3(p + 4096)) >> 8) / 16777216.0; }

float vnoise(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rand2(i),               rand2(i + ivec2(1, 0)), u.x),
             mix(rand2(i + ivec2(0, 1)), rand2(i + ivec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 3; k++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s / 0.875;
}

/* Each point walks its own circle, completing exactly one turn per loop. */
vec2 flowField(vec2 p) {
  float ang = TAU * vnoise(p + 11.3) + uPhase;
  float mag = 0.35 + 0.65 * vnoise(p + 27.9);
  return vec2(cos(ang), sin(ang)) * mag;
}

/* Fresnel-driven hue rotation in the a/b plane — thin-film sheen. */
vec3 iridesce(vec3 lab, float f) {
  float a = uIrid * f * -2.2;
  float c = cos(a), s = sin(a);
  return vec3(lab.x, c * lab.y - s * lab.z, s * lab.y + c * lab.z);
}

vec3 labRamp(float x) {
  float xx = clamp(x, 0.0, 1.0) * (uCount - 1.0);
  vec3 c = mix(uLab[0], uLab[1], clamp(xx, 0.0, 1.0));
  c = mix(c, uLab[2], clamp(xx - 1.0, 0.0, 1.0));
  c = mix(c, uLab[3], clamp(xx - 2.0, 0.0, 1.0));
  return c;
}

vec3 paletteLab(float t) {
  float x = pow(clamp(0.5 + 0.5 * cos(TAU * t), 0.0, 1.0), uBalance);
  vec3 lab = labRamp(x);
  float ang = TAU * (t * 2.0 + 0.123);
  lab.yz += 0.17 * uChroma * length(lab.yz) * vec2(sin(ang), cos(ang * 1.37 + 1.1));
  /* Cap to roughly the sRGB chroma ceiling. Scaling a/b keeps the hue angle;
     overshooting and clamping RGB later posterises into flat patches. */
  float ch = length(lab.yz);
  if (ch > 0.33) { lab.yz *= 0.33 / ch; }
  lab.x = clamp(0.5 + (lab.x - 0.5) * uContrast, 0.0, 1.0);
  return lab;
}

/* OkLab transform, Björn Ottosson, public domain. */
vec3 oklabToLinear(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  vec3 lms = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return mat3( 4.0767416621, -1.2684380046, -0.0041960863,
              -3.3077115913,  2.6097574011, -0.7034186147,
               0.2309699292, -0.3413193965,  1.7076147010) * lms;
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(0.0031308, c));
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / min(uRes.x, uRes.y);
  uv /= RAD;

  /* Silhouette wobble. Integer harmonics of the angle keep it continuous all
     the way round; integer multiples of the phase keep it periodic in time.
     Faded in with radius so the rim deforms like a drop while the core stays
     put — which also keeps it away from atan()'s singularity at the centre. */
  if (uWobble > 0.0) {
    float r0 = length(uv);
    float th = atan(uv.y, uv.x + 1e-6);
    float wob = 0.60 * sin(3.0 * th + uPhase)
              + 0.40 * sin(5.0 * th - 2.0 * uPhase)
              + 0.25 * sin(7.0 * th + 3.0 * uPhase);
    uv *= 1.0 - uWobble * 0.055 * wob * smoothstep(0.0, 0.5, r0);
  }

  float r = length(uv);
  vec2 pd = uv / max(r, 1.0);
  float z = sqrt(max(1.0 - dot(pd, pd), 0.0));
  vec3 n = vec3(pd, z);

  /* Domain warping. The base fBm is static; all the motion comes from warping
     its input through the looping flow field, and nesting a second warp is
     what turns smooth blobs into marbled, ink-in-water flow. */
  vec2 p0 = (pd - n.xy * uRefract) * uScaleN;
  vec2 p1 = p0 + uFlow * flowField(p0);
  vec2 p2 = p1 + uTurb * flowField(p1 * 1.7 + 5.2);
  float t = mix(0.5, fbm(p2 + 3.7), 1.35) + uShift;

  float fres3 = pow(1.0 - n.z, 3.0);
  vec3 lab = iridesce(paletteLab(t), fres3);

  vec3 base;
  if (uAberr > 0.001) {
    // Dispersion: the palette lookup shifts per channel, strongest at the rim.
    float d = uAberr * 0.05 * r * r;
    base = vec3(oklabToLinear(iridesce(paletteLab(t - d), fres3)).r,
                oklabToLinear(lab).g,
                oklabToLinear(iridesce(paletteLab(t + d), fres3)).b);
  } else {
    base = oklabToLinear(lab);
  }
  base = max(base, 0.0);

  // Lighting is added in linear light, which is where it belongs.
  vec3 L = normalize(uLight);
  vec3 col = mix(base, vec3(clamp(dot(n, L), 0.0, 1.0)), uShading);

  // Internal scatter offset away from the highlight: a translucent body rather
  // than a lit opaque ball.
  vec2 op = pd + L.xy * 0.45;
  col += uInner * exp(-dot(op, op) * 2.2) * base;

  vec3 half_ = normalize(L + vec3(0.0, 0.0, 1.0));
  col += pow(1.0 - n.z, 8.0) * uRim
       + pow(max(dot(n, half_), 0.0), 24.3) * uSpec;

  vec3 lit = linearToSrgb(col);
  vec3 flat_ = linearToSrgb(base);

  // Never thinner than ~1.5 device px, so the rim stays smooth when the
  // character is rendered small.
  float w = max(uSoft, 1.5 * fwidth(r));
  float body = 1.0 - smoothstep(1.0 - w, 1.0, r);

  /* The halo has to reach exactly zero before the canvas boundary. Left alone
     it is still ~1.5/255 at the edge and gets cut off square, which shows the
     canvas box as a faint rectangle around the orb. */
  float glowF = uGlow * exp(-max(r - 1.0, 0.0) * 20.0);
  glowF *= 1.0 - smoothstep(0.45, 1.0, (r - 1.0) / (RMAX - 1.0));
  float alpha = clamp(body + glowF * (1.0 - body), 0.0, 1.0);

  vec3 outCol = mix(flat_, lit, body);

  // Grain plus an always-on deband dither, stepped to 24 frames per loop so it
  // animates without breaking the seam.
  int frame = int(uPhase / TAU * 24.0);
  outCol += (rand3(ivec3(ivec2(gl_FragCoord.xy), frame)) - 0.5)
          * (uGrain * 0.1 + 1.0 / 255.0);

  outCol = clamp(outCol, 0.0, 1.0);
  fragColor = vec4(outCol * alpha, alpha);   // premultiplied
}`;

/**
 * Any CSS colour to OkLab. `getComputedStyle` resolves `var()` and named colours, but Chrome hands
 * `oklch()` back verbatim instead of converting it, so a 1x1 canvas rasterises whatever survives
 * into actual pixels.
 */
function toOklab(color: string): [number, number, number] {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [1, 0, 0];
  context.fillStyle = resolved;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = Array.from(
    context.getImageData(0, 0, 1, 1).data.slice(0, 3),
    (channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    },
  );
  // Cone responses, named for the long, medium and short wavelengths each one senses.
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

/** Draws the orb and keeps it looping while on screen. Returns its cleanup, or null if the shaders fail. */
function startOrb(
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
  colors: readonly string[],
) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertexShader || !fragmentShader) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND); // the shader writes premultiplied RGBA straight out

  for (const [name, value] of Object.entries(SURFACE_UNIFORMS)) {
    gl.uniform1f(gl.getUniformLocation(program, name), value);
  }
  gl.uniform3f(gl.getUniformLocation(program, "uLight"), -0.6, -1, 0.65);
  const stops = colors.slice(0, MAX_STOPS);
  gl.uniform1f(gl.getUniformLocation(program, "uCount"), Math.max(2, stops.length));
  gl.uniform3fv(
    gl.getUniformLocation(program, "uLab"),
    Array.from({ length: MAX_STOPS }, (_, index) =>
      toOklab(stops[Math.min(index, stops.length - 1)]),
    ).flat(),
  );
  const phaseUniform = gl.getUniformLocation(program, "uPhase");
  const resolutionUniform = gl.getUniformLocation(program, "uRes");

  function resize(entry?: ResizeObserverEntry) {
    const box = entry?.devicePixelContentBoxSize?.[0];
    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, box?.inlineSize ?? Math.round(rect.width * devicePixelRatio));
    const height = Math.max(1, box?.blockSize ?? Math.round(rect.height * devicePixelRatio));
    // Set even when the canvas is already this size: a remount (StrictMode, or new colours) reuses
    // the canvas with a fresh program whose resolution is still 0, which draws nothing.
    gl.viewport(0, 0, width, height);
    gl.uniform2f(resolutionUniform, width, height);
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    return true;
  }

  function draw() {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let phase = 0;
  let pendingMs = 0;
  let lastFrameMs = 0;
  let frame = 0;
  let onScreen = true;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function tick(nowMs: number) {
    frame = requestAnimationFrame(tick);
    const elapsedMs = lastFrameMs ? Math.min(nowMs - lastFrameMs, 100) : FRAME_CAP_MS;
    lastFrameMs = nowMs;
    pendingMs += elapsedMs;
    // Half a frame of slack: without it, a display whose vsync divides the cap almost exactly
    // drops an extra frame and the cadence stutters.
    if (pendingMs < FRAME_CAP_MS - elapsedMs * 0.5) return;
    phase = (phase + pendingMs / 1000 / LOOP_SECONDS) % 1;
    pendingMs = 0;
    gl.uniform1f(phaseUniform, phase * TAU);
    draw();
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  function start() {
    if (frame || reducedMotion.matches || !onScreen) return;
    lastFrameMs = 0;
    pendingMs = 0;
    frame = requestAnimationFrame(tick);
  }

  function applyMotionPreference() {
    if (!reducedMotion.matches) return start();
    stop();
    gl.uniform1f(phaseUniform, 0);
    draw();
  }

  resize();
  gl.uniform1f(phaseUniform, 0);
  draw();

  const resizeObserver = new ResizeObserver((entries) => {
    if (resize(entries[0]) && !frame) draw();
  });
  try {
    resizeObserver.observe(canvas, { box: "device-pixel-content-box" });
  } catch {
    resizeObserver.observe(canvas);
  }
  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      onScreen = entries.at(-1)?.isIntersecting ?? true;
      if (onScreen) start();
      else stop();
    },
    { rootMargin: "120px" },
  );
  visibilityObserver.observe(canvas);
  reducedMotion.addEventListener("change", applyMotionPreference);
  applyMotionPreference();

  return () => {
    stop();
    resizeObserver.disconnect();
    visibilityObserver.disconnect();
    reducedMotion.removeEventListener("change", applyMotionPreference);
    gl.deleteProgram(program);
    // Deliberately not WEBGL_lose_context: StrictMode remounts get the same canvas back with a
    // context that is still lost, and the orb latches into its fallback for good.
  };
}

export function Orb({
  colors,
  className,
}: {
  /** Two to four stops. The GL context is rebuilt when this changes, so pass a stable array. */
  colors: readonly string[];
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl2", {
      alpha: true,
      antialias: false, // a covering triangle has no geometric edges to sample
      depth: false,
      powerPreference: "low-power",
      premultipliedAlpha: true,
      stencil: false,
    });
    const stopOrb = canvas && gl ? startOrb(canvas, gl, colors) : null;
    // Set both ways: a failed first attempt must not disable the orb for good.
    setSupported(Boolean(stopOrb));
    return stopOrb ?? undefined;
  }, [colors]);

  if (!supported) {
    return (
      <div
        aria-hidden
        className={cn("rounded-full", className)}
        // Lit from the same corner as the shader, so the fallback faces the same way.
        style={{
          backgroundImage: `radial-gradient(circle at 32% 28%, ${colors.slice(0, MAX_STOPS).join(", ")})`,
        }}
      />
    );
  }

  return <canvas aria-hidden ref={canvasRef} tabIndex={-1} className={cn("block", className)} />;
}
