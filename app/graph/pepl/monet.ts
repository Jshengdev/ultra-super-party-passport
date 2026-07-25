/* The Monet pass — a chain of fullscreen post passes over the
   composited scene (graph sheet + bubble), mirroring the
   threshold→blur→composite pattern in reference/ChromaticSheet.jsx.

   Order is fixed: abstraction → grade → impasto.
   1. generalized Kuwahara (8-sector, Papari circular kernel), half res
   2. impressionist grade (no true black, violet shadows, warm lift)
   3. impasto relight (height from luminance, one light)
   The film grain rides the DOM veil above the whole surface now — see
   GrainVeil in PeplGraph.tsx — so it lands on the widgets too.        */

/* ---- pass 1: generalized Kuwahara, runs at half (or quarter) res ----
   8 sectors around each pixel, gaussian radial weight (the Papari
   circular kernel); each sector contributes its mean weighted by
   inverse variance^q. Small kernel: dots must stay dots, board
   segments must stay crisp shapes. WebGL1: constant loops, sector
   accumulation via an if-chain (no dynamic array indexing). */
export const KUWAHARA_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;      // resolution of this (half-res) target
uniform float uKernel;  // kernel radius in target px, 2..4

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 px = 1.0 / uRes;

  vec3 mean[8];
  vec3 sqr[8];
  float cnt[8];
  for (int i = 0; i < 8; i++) {
    mean[i] = vec3(0.0);
    sqr[i] = vec3(0.0);
    cnt[i] = 0.0;
  }

  const int R = 3;
  float rad = clamp(uKernel, 1.0, float(R));
  float sig2 = 0.5 * rad * rad;

  for (int y = -R; y <= R; y++) {
    for (int x = -R; x <= R; x++) {
      vec2 off = vec2(float(x), float(y));
      float d2 = dot(off, off);
      if (d2 > rad * rad + 0.5) continue;
      float w = exp(-d2 / sig2);
      vec3 c = texture2D(uTex, uv + off * px).rgb;
      vec3 cw = c * w;
      vec3 cw2 = c * c * w;
      if (x == 0 && y == 0) {
        /* centre belongs to every sector */
        for (int i = 0; i < 8; i++) {
          mean[i] += cw; sqr[i] += cw2; cnt[i] += w;
        }
      } else {
        float ang = atan(off.y, off.x) + 3.14159265;
        int k = int(mod(floor(ang / 0.78539816), 8.0));
        if (k == 0) { mean[0] += cw; sqr[0] += cw2; cnt[0] += w; }
        else if (k == 1) { mean[1] += cw; sqr[1] += cw2; cnt[1] += w; }
        else if (k == 2) { mean[2] += cw; sqr[2] += cw2; cnt[2] += w; }
        else if (k == 3) { mean[3] += cw; sqr[3] += cw2; cnt[3] += w; }
        else if (k == 4) { mean[4] += cw; sqr[4] += cw2; cnt[4] += w; }
        else if (k == 5) { mean[5] += cw; sqr[5] += cw2; cnt[5] += w; }
        else if (k == 6) { mean[6] += cw; sqr[6] += cw2; cnt[6] += w; }
        else { mean[7] += cw; sqr[7] += cw2; cnt[7] += w; }
      }
    }
  }

  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (cnt[i] > 1e-4) {
      vec3 m = mean[i] / cnt[i];
      vec3 v = max(sqr[i] / cnt[i] - m * m, 0.0);
      float sig = dot(v, vec3(0.299, 0.587, 0.114));
      float wk = 1.0 / (1.0 + pow(255.0 * sig, 3.0));
      acc += m * wk;
      wsum += wk;
    }
  }
  gl_FragColor = vec4(acc / max(wsum, 1e-5), 1.0);
}
`;

/* ---- exportQuality stills: anisotropic Kuwahara ----
   Structure-tensor pass (Sobel of luminance, packed E/G/F) followed by
   an oriented elliptical 8-sector kernel per Kyprianidis/Heckel. Too
   expensive for realtime here — same conclusion as the research doc —
   so it only runs while the exportQuality flag is on. */
export const TENSOR_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 px = 1.0 / uRes;
  float tl = lum(texture2D(uTex, uv + px * vec2(-1.0,  1.0)).rgb);
  float tc = lum(texture2D(uTex, uv + px * vec2( 0.0,  1.0)).rgb);
  float tr = lum(texture2D(uTex, uv + px * vec2( 1.0,  1.0)).rgb);
  float ml = lum(texture2D(uTex, uv + px * vec2(-1.0,  0.0)).rgb);
  float mr = lum(texture2D(uTex, uv + px * vec2( 1.0,  0.0)).rgb);
  float bl = lum(texture2D(uTex, uv + px * vec2(-1.0, -1.0)).rgb);
  float bc = lum(texture2D(uTex, uv + px * vec2( 0.0, -1.0)).rgb);
  float br = lum(texture2D(uTex, uv + px * vec2( 1.0, -1.0)).rgb);
  float gx = (tr + 2.0 * mr + br - tl - 2.0 * ml - bl) * 0.25;
  float gy = (tl + 2.0 * tc + tr - bl - 2.0 * bc - br) * 0.25;
  /* E = gx², G = gy², F = gx·gy (signed, packed into 0..1) */
  gl_FragColor = vec4(gx * gx, gy * gy, gx * gy * 0.5 + 0.5, 1.0);
}
`;

export const ANISO_KUWAHARA_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uTensor;
uniform vec2 uRes;
uniform float uKernel; // base radius in px

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 px = 1.0 / uRes;

  /* 3×3-smoothed structure tensor */
  float E = 0.0; float G = 0.0; float F = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec3 s = texture2D(uTensor, uv + vec2(float(i), float(j)) * px).xyz;
      E += s.x; G += s.y; F += s.z * 2.0 - 1.0;
    }
  }
  E /= 9.0; G /= 9.0; F /= 9.0;

  /* eigenvalues + minor eigenvector = local edge direction */
  float D = sqrt(max((E - G) * (E - G) + 4.0 * F * F, 0.0));
  float l1 = 0.5 * (E + G + D);
  float l2 = 0.5 * (E + G - D);
  float A = (l1 + l2 > 1e-7) ? (l1 - l2) / (l1 + l2) : 0.0;
  vec2 v = vec2(l1 - E, -F);
  vec2 dir = (length(v) > 1e-7) ? normalize(v) : vec2(0.0, 1.0);
  vec2 perp = vec2(-dir.y, dir.x);

  /* ellipse: stretched along the structure, squeezed across it */
  float rad = clamp(uKernel, 1.0, 5.0);
  float ea = rad * (1.0 + A);
  float eb = rad / (1.0 + A);

  vec3 mean[8];
  vec3 sqr[8];
  float cnt[8];
  for (int i = 0; i < 8; i++) {
    mean[i] = vec3(0.0);
    sqr[i] = vec3(0.0);
    cnt[i] = 0.0;
  }

  const int R = 5;
  for (int y = -R; y <= R; y++) {
    for (int x = -R; x <= R; x++) {
      vec2 o = vec2(float(x), float(y));
      /* into ellipse space */
      vec2 e = vec2(dot(o, dir) / ea, dot(o, perp) / eb);
      float d2 = dot(e, e);
      if (d2 > 1.0) continue;
      float w = exp(-3.125 * d2);
      vec3 c = texture2D(uTex, uv + o * px).rgb;
      vec3 cw = c * w;
      vec3 cw2 = c * c * w;
      if (x == 0 && y == 0) {
        for (int i = 0; i < 8; i++) { mean[i] += cw; sqr[i] += cw2; cnt[i] += w; }
      } else {
        float ang = atan(e.y, e.x) + 3.14159265;
        int k = int(mod(floor(ang / 0.78539816), 8.0));
        if (k == 0) { mean[0] += cw; sqr[0] += cw2; cnt[0] += w; }
        else if (k == 1) { mean[1] += cw; sqr[1] += cw2; cnt[1] += w; }
        else if (k == 2) { mean[2] += cw; sqr[2] += cw2; cnt[2] += w; }
        else if (k == 3) { mean[3] += cw; sqr[3] += cw2; cnt[3] += w; }
        else if (k == 4) { mean[4] += cw; sqr[4] += cw2; cnt[4] += w; }
        else if (k == 5) { mean[5] += cw; sqr[5] += cw2; cnt[5] += w; }
        else if (k == 6) { mean[6] += cw; sqr[6] += cw2; cnt[6] += w; }
        else { mean[7] += cw; sqr[7] += cw2; cnt[7] += w; }
      }
    }
  }

  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (cnt[i] > 1e-4) {
      vec3 m = mean[i] / cnt[i];
      vec3 vv = max(sqr[i] / cnt[i] - m * m, 0.0);
      float sig = dot(vv, vec3(0.299, 0.587, 0.114));
      float wk = 1.0 / (1.0 + pow(255.0 * sig + 1e-4, 3.0));
      acc += m * wk;
      wsum += wk;
    }
  }
  gl_FragColor = vec4(acc / max(wsum, 1e-5), 1.0);
}
`;

/* ---- pass 2: composite + impressionist grade ----
   Blends the Kuwahara abstraction over the scene (masked down to ~30%
   inside the bubble's clear zone — lens legibility is sacred), then
   grades: no true black (darkest values compress toward dark
   blue-violet), violet-blue shadow tint, warm high-key lift, gentle
   midtone saturation. The film palette must survive the grade. */
export const GRADE_FRAG = `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uKuwa;
uniform vec2 uRes;
uniform float uKuwaAmt;
uniform float uGradeAmt;
uniform vec2 uCenter;   // bubble centre, shader space
uniform float uRadius;  // bubble radius, shader space

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float mn = min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / mn;

  vec3 scene = texture2D(uScene, uv).rgb;
  vec3 kuwa = texture2D(uKuwa, uv).rgb;

  float d = length(p - uCenter) / max(uRadius, 1e-4);
  float clearMask = mix(0.3, 1.0, smoothstep(0.55, 1.05, d));
  vec3 col = mix(scene, kuwa, uKuwaAmt * clearMask);

  /* grade */
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 g = col;

  // shadows drift blue-violet, and nothing reaches true black
  vec3 shadowTint = vec3(0.22, 0.19, 0.38);
  float sh = 1.0 - smoothstep(0.0, 0.42, luma);
  g = mix(g, max(g, shadowTint * (0.55 + 0.45 * luma)), sh * 0.75);

  // warm high-key lift
  float hi = smoothstep(0.62, 1.0, luma);
  g += vec3(0.055, 0.038, 0.012) * hi;

  // gentle midtone saturation
  float mid = smoothstep(0.15, 0.5, luma) * (1.0 - smoothstep(0.6, 0.95, luma));
  float l2 = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l2), g, 1.0 + 0.22 * mid);

  col = mix(col, g, uGradeAmt);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ---- pass 3: impasto relight ----
   Height field from luminance, normals via gradient, one directional
   light with a soft specular. Very low strength — the board glow must
   still read as light, not paint.

   The canvas-weave term and overlay are GONE by decree: at any period
   the lattice read as scan lines over the sheet, so the finish keeps
   only the relight. Grain now lives in the DOM veil (GrainVeil in
   PeplGraph.tsx), where it can also cover the widgets the shader can't
   reach. */
export const FINISH_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uImpasto;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 px = 1.0 / uRes;
  vec3 col = texture2D(uTex, uv).rgb;

  float h = luma(col);
  float hx = luma(texture2D(uTex, uv + vec2(px.x, 0.0)).rgb);
  float hy = luma(texture2D(uTex, uv + vec2(0.0, px.y)).rgb);

  vec3 n = normalize(vec3(-(hx - h) * 6.0, -(hy - h) * 6.0, 1.0));
  vec3 L = normalize(vec3(-0.42, 0.58, 0.72));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), n), L), 0.0), 26.0);

  vec3 lit = col * (0.94 + 0.10 * diff) + spec * 0.08;
  col = mix(col, lit, uImpasto);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
