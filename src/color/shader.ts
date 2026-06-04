export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Grading pipeline (order matters, see notes):
 *  decode sRGB -> linear
 *  white balance -> exposure -> shadows/highlights -> contrast (linear)
 *  tone map (linear -> display)
 *  -> teal&orange split tone -> saturation/vibrance -> faded blacks
 *  -> vignette -> grain -> dither -> letterbox
 */
export const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uResolution;
uniform float uTime;
uniform float uTemp, uTint, uExposure, uContrast, uShadows, uHighlights;
uniform float uSaturation, uVibrance, uTeal, uFade, uVignette, uGrain, uLetterbox;
uniform int uToneMap;
in vec2 vUv;
out vec4 frag;

vec3 srgbToLinear(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 reinhard(vec3 x){ return x / (1.0 + x); }
vec3 aces(vec3 x){
  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 hableP(vec3 x){
  float A=0.15,B=0.50,C=0.10,D=0.20,E=0.02,F=0.30;
  return ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F)) - E/F;
}
vec3 hable(vec3 x){
  return hableP(x * 2.0) / hableP(vec3(11.2));
}

float hash(vec2 p){
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(){
  vec3 src = texture(uTex, vUv).rgb;
  vec3 lin = srgbToLinear(src);

  // white balance — warm/cool on R/B, green/magenta on G
  vec3 wb = vec3(1.0 + uTemp * 0.45, 1.0 - uTint * 0.25, 1.0 - uTemp * 0.45);
  lin *= wb;

  // exposure
  lin *= exp2(uExposure);

  // shadows / highlights (luminance masks)
  float L = luma(lin);
  float sMask = 1.0 - smoothstep(0.0, 0.5, L);
  float hMask = smoothstep(0.5, 1.2, L);
  lin += uShadows * 0.5 * sMask;
  lin += uHighlights * 0.5 * hMask;
  lin = max(lin, 0.0);

  // contrast around middle grey (linear pivot 0.18)
  lin = (lin - 0.18) * (1.0 + uContrast) + 0.18;
  lin = max(lin, 0.0);

  // tone map (linear -> display intent)
  if (uToneMap == 1) lin = reinhard(lin);
  else if (uToneMap == 2) lin = aces(lin);
  else if (uToneMap == 3) lin = hable(lin);
  else lin = clamp(lin, 0.0, 1.0);

  vec3 col = linearToSrgb(lin);

  // teal & orange split toning
  if (uTeal > 0.0){
    float l = luma(col);
    vec3 teal = vec3(0.0, 0.45, 0.55);
    vec3 orange = vec3(1.0, 0.52, 0.18);
    float lowM = 1.0 - smoothstep(0.0, 0.5, l);
    float highM = smoothstep(0.4, 1.0, l);
    col = mix(col, col * 0.8 + teal * 0.2, lowM * uTeal);
    col = mix(col, col * 0.8 + orange * 0.2, highM * uTeal);
  }

  // saturation + vibrance (vibrance boosts low-sat areas more)
  float l2 = luma(col);
  col = mix(vec3(l2), col, 1.0 + uSaturation);
  float sat = length(col - vec3(l2));
  float vib = uVibrance * (1.0 - smoothstep(0.0, 0.45, sat));
  col = mix(vec3(l2), col, 1.0 + vib);

  // faded film (lifted blacks)
  col = mix(col, vec3(0.06) + col * 0.92, uFade);

  // vignette
  vec2 dd = vUv - 0.5;
  col *= clamp(1.0 - uVignette * dot(dd, dd) * 2.4, 0.0, 1.0);

  // grain
  if (uGrain > 0.0){
    float n = hash(vUv * uResolution + uTime);
    col += (n - 0.5) * uGrain * 0.14;
  }

  // ordered-ish dither to fight 8-bit banding
  col += (hash(vUv * uResolution) - 0.5) / 255.0;

  col = clamp(col, 0.0, 1.0);

  // letterbox (crop to target aspect with black bars)
  if (uLetterbox > 0.0){
    float frameAspect = uResolution.x / uResolution.y;
    float visible = clamp(frameAspect / uLetterbox, 0.0, 1.0);
    float bar = (1.0 - visible) * 0.5;
    if (vUv.y < bar || vUv.y > 1.0 - bar) col = vec3(0.0);
  }

  frag = vec4(col, 1.0);
}`;
