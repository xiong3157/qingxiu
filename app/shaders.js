// GLSL ES 3.00 着色器
// 顶点着色器：把 0..1 的单位网格映射到裁剪空间，并在纹理空间做位移采样（液化）

export const MESH_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;

uniform vec2  uClipOrigin;
uniform vec2  uClipSize;
uniform mat2  uUvXf;
uniform vec2  uCropScale;
uniform vec2  uCropOffset;
uniform sampler2D uDisp;
uniform float uDispAmp;
uniform float uDispOn;

out vec2 vUV;
out vec2 vPos;

void main() {
  vec2 t  = uUvXf * (aPos - 0.5) + 0.5;
  vec2 uv = t * uCropScale + uCropOffset;

  vec2 d = (texture(uDisp, uv).rg - 0.5) * (2.0 * uDispAmp * uDispOn);
  uv += d;

  vec2 lo = uCropOffset + 0.0008;
  vec2 hi = uCropOffset + uCropScale - 0.0008;
  vUV = clamp(uv, lo, max(lo, hi));
  vPos = aPos;

  gl_Position = vec4(uClipOrigin + aPos * uClipSize, 0.0, 1.0);
}`;

// 片元着色器：锐化 → 磨皮/美白 → 滤镜 → 调色 → 暗角/颗粒
export const BASE_FRAG = `#version 300 es
precision highp float;

in vec2 vUV;
in vec2 vPos;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2  uTexel;

uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemp;
uniform float uTint;
uniform float uHighlights;
uniform float uShadows;
uniform float uSharpen;
uniform float uVignette;
uniform float uGrain;

uniform float uSoften;
uniform float uWhiten;

uniform mat3  uFilterMat;
uniform vec3  uFilterGamma;
uniform vec3  uFilterLift;
uniform float uFilterAmt;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float skinMask(vec3 c) {
  float y  = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b + 0.5;
  float cr =  0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b + 0.5;

  float m = smoothstep(0.300, 0.372, cb) * (1.0 - smoothstep(0.452, 0.518, cb));
  m *= smoothstep(0.512, 0.560, cr) * (1.0 - smoothstep(0.638, 0.700, cr));
  m *= smoothstep(0.10, 0.26, y);
  return clamp(m, 0.0, 1.0);
}

// 边缘保留的双边式模糊，只用来平滑皮肤纹理
vec3 smoothSkin(vec3 c0, vec2 uv) {
  float r = 1.2 + uSoften * 3.4;
  vec3 sum = c0;
  float wsum = 1.0;

  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    vec2 dir = vec2(cos(a), sin(a));
    for (int k = 0; k < 2; k++) {
      float dd = k == 0 ? 1.0 : 0.58;
      vec3 cs = texture(uTex, uv + dir * (r * dd) * uTexel).rgb;
      vec3 diff = cs - c0;
      float w = exp(-dot(diff, diff) * 52.0);
      sum += cs * w;
      wsum += w;
    }
  }
  return sum / wsum;
}

void main() {
  vec2 uv = vUV;
  vec3 c0 = texture(uTex, uv).rgb;
  vec3 c = c0;

  if (uSharpen > 0.001) {
    vec3 n = texture(uTex, uv + vec2(uTexel.x, 0.0)).rgb
           + texture(uTex, uv - vec2(uTexel.x, 0.0)).rgb
           + texture(uTex, uv + vec2(0.0, uTexel.y)).rgb
           + texture(uTex, uv - vec2(0.0, uTexel.y)).rgb;
    c = c0 + (c0 - n * 0.25) * uSharpen * 1.8;
  }

  if (uSoften > 0.001 || uWhiten > 0.001) {
    float m = skinMask(c);
    if (m > 0.008) {
      if (uSoften > 0.001) {
        vec3 sm = smoothSkin(c, uv);
        c = mix(c, sm, m * uSoften * 0.92);
      }
      if (uWhiten > 0.001) {
        vec3 lifted = mix(c, vec3(1.0), 0.26) * 1.03;
        c = mix(c, lifted, m * uWhiten * 0.85);
        c += m * uWhiten * 0.035;
      }
    }
  }

  if (uFilterAmt > 0.001) {
    vec3 f = clamp(uFilterMat * c + uFilterLift, 0.0, 1.0);
    f = pow(f, uFilterGamma);
    c = mix(c, f, uFilterAmt);
  }

  c *= 1.0 + uBrightness * 0.60;
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  c.r += uTemp * 0.10;
  c.b -= uTemp * 0.10;
  c.g += uTint * 0.055;
  c.r -= uTint * 0.028;
  c.b -= uTint * 0.028;

  float l = dot(clamp(c, 0.0, 1.0), LUMA);
  c += uHighlights * 0.34 * smoothstep(0.52, 1.0, l);
  c += uShadows * 0.34 * (1.0 - smoothstep(0.0, 0.46, l));

  float g = dot(clamp(c, 0.0, 1.0), LUMA);
  c = mix(vec3(g), c, 1.0 + uSaturation);

  if (uVignette > 0.001) {
    float d = distance(vPos, vec2(0.5)) * 1.41421;
    c *= 1.0 - uVignette * 0.85 * smoothstep(0.42, 1.0, d);
  }

  if (uGrain > 0.001) {
    float n = hash(floor(vPos * 1400.0));
    c += (n - 0.5) * uGrain * 0.16;
  }

  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// 液化笔刷：把位移增量累加进位移贴图（ping-pong）
export const STAMP_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

export const STAMP_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uPrev;
uniform vec2  uCenter;
uniform vec2  uDelta;
uniform float uRadius;
uniform float uAspect;

void main() {
  vec2 d = vUV - uCenter;
  d.x *= uAspect;
  float f = 1.0 - smoothstep(0.0, 1.0, length(d) / uRadius);
  f = f * f;

  vec2 cur = texture(uPrev, vUV).rg - 0.5;
  cur += uDelta * f;
  cur = clamp(cur, -0.499, 0.499);

  outColor = vec4(cur + 0.5, 0.0, 1.0);
}`;
