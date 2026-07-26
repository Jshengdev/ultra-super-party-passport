/* The soap-bubble lens shader, ported intact from reference/Bubble.jsx.
   Thin-film interference from the CIE observer, silhouette wobble,
   volume-preserving deformation, and the split lens: uniform
   magnification toward the centre, fisheye riding the rim only. */

export const BUBBLE_FRAG = `
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;
uniform sampler2D uTex;

uniform vec2  uCenter;   // bubble position, shader space
uniform vec2  uDeform;   // stretch axis + magnitude
uniform vec2  uVel;      // body velocity, sloshes the film

uniform float uThick;
uniform float uDrain;
uniform float uWobble;
uniform float uSurface;
uniform float uFlow;
uniform float uTurb;
uniform float uChroma;
uniform float uEdge;
uniform float uZoom;
uniform float uWarp;
uniform float uRadius;
uniform float uBack;
uniform float uGrain;

/* ---------- simplex noise (Ashima / Gustavson) ---------- */
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

/* ---------- spectrum to colour ----------
   Wyman/Sloan/Shirley piecewise-Gaussian fit of the CIE 1931 observer. */
float gpg(float x, float mu, float s1, float s2){
  float t = (x - mu) * (x < mu ? 1.0/s1 : 1.0/s2);
  return exp(-0.5 * t * t);
}
vec3 cie(float w){
  float x = 1.056*gpg(w,599.8,37.9,31.0) + 0.362*gpg(w,442.0,16.0,26.7) - 0.065*gpg(w,501.1,20.4,26.2);
  float y = 0.821*gpg(w,568.8,46.9,40.5) + 0.286*gpg(w,530.9,16.3,31.1);
  float z = 1.217*gpg(w,437.0,11.8,36.0) + 0.681*gpg(w,459.0,26.0,13.8);
  return vec3(x, y, z);
}
vec3 xyzToRgb(vec3 c){
  return vec3(
     3.2406*c.x - 1.5372*c.y - 0.4986*c.z,
    -0.9689*c.x + 1.8758*c.y + 0.0415*c.z,
     0.0557*c.x - 0.2040*c.y + 1.0570*c.z
  );
}
vec3 filmColor(float opd){
  vec3 acc = vec3(0.0);
  float norm = 0.0;
  for (int i = 0; i < 9; i++) {
    float w = 400.0 + float(i) * 36.0;
    float I = 0.5 - 0.5 * cos(6.28318530718 * opd / w);
    vec3 c = cie(w);
    acc  += c * I;
    norm += c.y;
  }
  return max(xyzToRgb(acc / norm), 0.0);
}

/* ---------- film thickness across the sphere ---------- */
float thickness(vec3 n, float seed, float detail, float ripple){
  vec3 q = n * 2.0;
  q.y -= uTime * 0.045 * uFlow;
  q.x += uTime * 0.012 * uFlow;
  q.xy -= uVel * 0.26;

  float k = clamp(uTurb, 0.0, 1.5);
  float scale = mix(0.85, 1.70, clamp(k, 0.0, 1.0));
  vec2 warp = vec2(snoise(q * 0.80 + seed), snoise(q * 0.80 + seed + 17.3));
  vec3 wq = q * scale + vec3(warp * k * 0.80, 0.0);

  float f  = snoise(wq) * 0.62;
  f += snoise(wq * 2.10 + seed) * 0.30 * detail * clamp(k, 0.0, 1.0);
  f *= ripple;

  float h = n.y * 0.5 + 0.5;
  float grav = mix(1.0 + uDrain * 0.95, max(0.04, 1.0 - uDrain), pow(h, 1.55));

  return uThick * grav * (1.0 + 0.75 * f);
}

vec3 env(vec3 r){
  float up = r.y * 0.5 + 0.5;
  vec3 c = mix(vec3(0.76, 0.745, 0.725), vec3(1.0, 0.993, 0.978), up);
  c += 0.42 * pow(max(dot(r, normalize(vec3(-0.42, 0.58, 0.70))), 0.0), 7.0);
  c += 0.10 * pow(max(dot(r, normalize(vec3( 0.55,-0.35, 0.75))), 0.0), 4.0);
  return c;
}

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/* ---------- the transmitted tap ----------
   The lens magnifies (uZoom), so inside the glass the sheet is read BETWEEN
   its texels — and bilinear reconstruction is exactly a one-texel box blur at
   that point, which is the whole of "the text behind it is blurry". Catmull-
   Rom reads the same 4x4 neighbourhood with a cubic that has negative lobes,
   so a magnified stroke comes back as a stroke instead of a ramp; the
   sharpness holds as the magnification (or the bubble) is scaled up, because
   the kernel is defined in SOURCE texels, not screen ones.

   Four fetches via the Sigg/Hadwiger trick (each hardware-bilinear fetch
   carries two taps), and only inside the silhouette — the room outside the
   bubble still costs one tap. Nothing here touches the morphism: it changes
   how the sheet is READ, never how the film is drawn. */
vec3 sharpTap(vec2 uv){
  vec2 tc = uv * uRes - 0.5;
  vec2 base = floor(tc);
  vec2 f = tc - base;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 2.0 * f2 - f) * 0.5;
  vec2 w1 = (3.0 * f3 - 5.0 * f2 + 2.0) * 0.5;
  vec2 w2 = (-3.0 * f3 + 4.0 * f2 + f) * 0.5;
  vec2 w3 = (f3 - f2) * 0.5;
  /* s0 vanishes only as f→1 and s1 only as f→0, in both cases together with
     the numerator above them — the floor keeps 0/0 out of the divide, and
     where it bites the pair carries no weight anyway */
  vec2 s0 = max(w0 + w1, 1e-5);
  vec2 s1 = max(w2 + w3, 1e-5);
  vec2 t0 = (base + w1 / s0 - 0.5) / uRes;
  vec2 t1 = (base + w3 / s1 + 1.5) / uRes;
  return texture2D(uTex, vec2(t0.x, t0.y)).rgb * (s0.x * s0.y)
       + texture2D(uTex, vec2(t1.x, t0.y)).rgb * (s1.x * s0.y)
       + texture2D(uTex, vec2(t0.x, t1.y)).rgb * (s0.x * s1.y)
       + texture2D(uTex, vec2(t1.x, t1.y)).rgb * (s1.x * s1.y);
}

void main(){
  float mn = min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / mn;

  vec3 col = texture2D(uTex, gl_FragCoord.xy / uRes).rgb;
  // gentle vignette over the sheet
  col -= 0.025 * smoothstep(0.25, 1.15, length(p));

  /* --- deformed local frame, volume preserving --- */
  vec2 pc = p - uCenter;
  float m  = min(length(uDeform), 0.42);
  vec2 ax  = m > 1e-4 ? normalize(uDeform) : vec2(1.0, 0.0);
  vec2 tg  = vec2(-ax.y, ax.x);
  float s  = 1.0 + m;
  vec2 loc = vec2(dot(pc, ax) / s, dot(pc, tg) * s);

  /* --- silhouette --- */
  float ang = atan(loc.y, loc.x);
  vec2 cs = vec2(cos(ang), sin(ang));
  float def = snoise(vec3(cs * 0.95, uTime * 0.085)) * 0.74
            + snoise(vec3(cs * 2.05, uTime * 0.125 + 8.0)) * 0.15;
  float breathe = 1.0 + 0.004 * sin(uTime * 0.27) + 0.002 * sin(uTime * 0.43 + 1.7);
  float R = max(uRadius, 1e-4) * breathe * (1.0 + uWobble * def);

  float d  = length(loc) / R;
  float aa = (1.6 / mn) / R;
  float mask = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);

  if (mask > 0.0015) {
    float dc = min(d, 1.0);
    float z  = sqrt(max(1e-5, 1.0 - dc * dc));
    vec2 nl = loc / R;
    vec2 nw = (nl.x / s) * ax + (nl.y * s) * tg;
    vec3 N  = normalize(vec3(nw, z));

    // undulation lives at the rim only
    float und = uSurface * smoothstep(0.30, 0.98, d);
    vec3 j = vec3(
      snoise(N * 1.30 + vec3(0.0, 0.0, uTime * 0.11)),
      snoise(N * 1.30 + vec3(5.2, 1.3, uTime * 0.11)),
      0.0
    );
    N = normalize(N + j * und);

    vec3 V = vec3(0.0, 0.0, 1.0);
    float cosI = clamp(dot(N, V), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);

    float sinI = sqrt(max(0.0, 1.0 - cosI * cosI));
    float sinT = sinI / 1.33;
    float cosT = sqrt(max(0.0, 1.0 - sinT * sinT));

    // the film noise fades to a tenth inside a third of the radius
    float rip = mix(0.10, 1.0, smoothstep(0.30, 0.92, d));

    float tF = thickness(N, 0.0, 1.0, rip);
    vec3  cF = filmColor(2.0 * 1.33 * tF * cosT);

    vec3 Nb = vec3(N.x, N.y, -N.z);
    float tB = thickness(Nb, 41.7, 0.0, rip);
    vec3  cB = filmColor(2.0 * 1.33 * tB * cosT);

    // confine hue to the rim: collapse the centre to its own luminance
    float chromaMask = smoothstep(uEdge, 0.995, d);
    cF = mix(vec3(dot(cF, vec3(0.2126, 0.7152, 0.0722))), cF, chromaMask);
    cB = mix(vec3(dot(cB, vec3(0.2126, 0.7152, 0.0722))), cB, chromaMask);

    vec3 Rv = reflect(-V, N);
    vec3 L  = normalize(vec3(uMouse.x * 0.55 - 0.35, uMouse.y * 0.45 + 0.50, 0.78));

    float gain  = clamp(F * 3.6, 0.0, 1.0);
    float gainB = gain * uBack;

    // haze thins over the centre so the lensed sheet stays legible
    float clear = mix(0.45, 1.0, smoothstep(0.18, 0.92, d));
    vec3 refl = (mix(env(Rv), cF, 0.72 * uChroma) * gain
               + cB * gainB * 0.85 * uChroma) * clear;

    float rim = smoothstep(0.84, 1.0, d);
    refl += cF * rim * 0.55 * uChroma;

    float s1 = pow(max(dot(Rv, L), 0.0), 900.0) * 2.4;
    float s2 = pow(max(dot(Rv, L), 0.0), 42.0) * 0.10;
    float s3 = pow(max(dot(reflect(-V, Nb), L * vec3(-1.0, -1.0, 1.0)), 0.0), 200.0) * 0.35;

    /* --- the lens ---
       Magnification is uniform: sample coordinates compressed toward the
       bubble centre. The fisheye rides the sphere normal, which is zero
       where the surface faces you and grows toward the rim, so the middle
       stays honest and only the edge smears. */
    vec2 q = uCenter + pc / max(uZoom, 1.0);
    q -= N.xy * uWarp * pow(1.0 - cosI, 1.5) * 0.55;
    vec2 uv = clamp((q * mn + 0.5 * uRes) / uRes, 0.0, 1.0);

    float absorb = clamp((gain + gainB * 0.4) * clear, 0.0, 1.0);
    vec3 trans = clamp(sharpTap(uv), 0.0, 1.0) * (1.0 - absorb * 0.80);

    vec3 bubble = trans + refl + vec3(s1 + s2 + s3);
    col = mix(col, bubble, mask);
  }

  col += (hash21(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const BUBBLE_UNIFORMS = [
  "uRes", "uTime", "uMouse", "uTex", "uCenter", "uDeform", "uVel",
  "uThick", "uDrain", "uWobble", "uSurface", "uFlow", "uTurb", "uChroma",
  "uEdge", "uZoom", "uWarp", "uRadius", "uBack", "uGrain",
];
