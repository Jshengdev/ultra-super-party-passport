/* Minimal WebGL1 plumbing shared by the lens pass and the Monet chain. */

export function compileProgram(
  gl: WebGLRenderingContext,
  vert: string,
  frag: string
): WebGLProgram {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || "shader compile failed");
    }
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "program link failed");
  }
  return prog;
}

export function uniformMap(
  gl: WebGLRenderingContext,
  prog: WebGLProgram,
  names: string[]
): Record<string, WebGLUniformLocation | null> {
  const U: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) U[n] = gl.getUniformLocation(prog, n);
  return U;
}

/* NPOT-safe texture: clamp, linear, no mips */
export function makeTexture(gl: WebGLRenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export type RenderTarget = {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
};

export function makeTarget(
  gl: WebGLRenderingContext,
  w: number,
  h: number
): RenderTarget {
  const tex = makeTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, w, h };
}

export function destroyTarget(gl: WebGLRenderingContext, rt: RenderTarget | null) {
  if (!rt) return;
  gl.deleteFramebuffer(rt.fbo);
  gl.deleteTexture(rt.tex);
}

/* one shared fullscreen triangle */
export function bindFullscreenTriangle(
  gl: WebGLRenderingContext,
  progs: WebGLProgram[]
): WebGLBuffer {
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  for (const p of progs) {
    const aPos = gl.getAttribLocation(p, "aPos");
    if (aPos >= 0) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    }
  }
  return buf;
}

export const QUAD_VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;
