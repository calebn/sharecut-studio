import { premultiply } from "./shade";
import type { Rgba } from "./types";

/**
 * WebGL2 rasterizer (S6). One full-screen triangle; each fragment reads its
 * column's shared geometry (`shade.ts` `columnGeometry`) from a `cols × 1`
 * RGBA32F texture and applies the same row coverage as `rasterCpu`.
 */

export const GL_CONTEXT_OPTIONS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  preserveDrawingBuffer: false,
  powerPreference: "low-power",
};

export const VERTEX_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// cover() is shade.ts rowCoverage(); the output is shade.ts's premultiplied
// core·rc + edge·(pc − rc). Row 0 is the top row (transferToImageBitmap
// output is upright).
export const FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uGeom;
uniform vec2 uSize;
uniform vec4 uCore;
uniform vec4 uEdge;
out vec4 outColor;
float cover(float y, float a, float b) {
  return max(0.0, min(y + 1.0, b) - max(y, a));
}
void main() {
  vec4 g = texelFetch(uGeom, ivec2(int(gl_FragCoord.x), 0), 0);
  float y0 = uSize.y - gl_FragCoord.y - 0.5;
  float pc = cover(y0, g.x, g.y);
  float rc = cover(y0, g.z, g.w);
  outColor = uCore * rc + uEdge * (pc - rc);
}
`;

/** The parts of an `OffscreenCanvas` the rasterizer uses. */
export type GlCanvas = {
  width: number;
  height: number;
  getContext(
    id: "webgl2",
    options?: WebGLContextAttributes,
  ): WebGL2RenderingContext | null;
  addEventListener(type: "webglcontextlost", listener: () => void): void;
};

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

type Uniforms = {
  size: WebGLUniformLocation | null;
  core: WebGLUniformLocation | null;
  edge: WebGLUniformLocation | null;
};

export class GlRaster {
  /** Set once the context is lost; the worker then renders on the CPU. */
  lost = false;
  private readonly canvas: GlCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly uniforms: Uniforms;
  private readonly texture: WebGLTexture;

  private constructor(
    canvas: GlCanvas,
    gl: WebGL2RenderingContext,
    uniforms: Uniforms,
    texture: WebGLTexture,
  ) {
    this.canvas = canvas;
    this.gl = gl;
    this.uniforms = uniforms;
    this.texture = texture;
    canvas.addEventListener("webglcontextlost", () => {
      this.lost = true;
    });
  }

  /** A rasterizer on `canvas`, or null when WebGL2 or the shaders fail. */
  static create(canvas: GlCanvas): GlRaster | null {
    const gl = canvas.getContext("webgl2", GL_CONTEXT_OPTIONS);
    if (!gl) {
      return null;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram();
    const texture = gl.createTexture();
    if (!vs || !fs || !program || !texture) {
      return null;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      return null;
    }
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, "uGeom"), 0);
    gl.disable(gl.BLEND);
    return new GlRaster(
      canvas,
      gl,
      {
        size: gl.getUniformLocation(program, "uSize"),
        core: gl.getUniformLocation(program, "uCore"),
        edge: gl.getUniformLocation(program, "uEdge"),
      },
      texture,
    );
  }

  /** Draw `cols × rows` into the canvas from the shared column geometry. */
  render(
    geom: Float32Array,
    cols: number,
    rows: number,
    core: Rgba,
    edge: Rgba,
  ): void {
    const { gl, canvas } = this;
    if (canvas.width !== cols) {
      canvas.width = cols;
    }
    if (canvas.height !== rows) {
      canvas.height = rows;
    }
    gl.viewport(0, 0, cols, rows);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      cols,
      1,
      0,
      gl.RGBA,
      gl.FLOAT,
      geom,
    );
    gl.uniform2f(this.uniforms.size, cols, rows);
    gl.uniform4fv(this.uniforms.core, premultiply(core));
    gl.uniform4fv(this.uniforms.edge, premultiply(edge));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * The drawn pixels as premultiplied RGBA, top row first (`readPixels`
   * returns the bottom row first). Call right after `render`.
   */
  readTopDown(cols: number, rows: number): Uint8Array {
    const { gl } = this;
    const raw = new Uint8Array(cols * rows * 4);
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(raw.length);
    const stride = cols * 4;
    for (let y = 0; y < rows; y++) {
      out.set(
        raw.subarray((rows - 1 - y) * stride, (rows - y) * stride),
        y * stride,
      );
    }
    return out;
  }
}
