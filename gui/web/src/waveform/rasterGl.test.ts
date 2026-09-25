import { describe, expect, it, vi } from "vitest";
import { newEnvelope } from "./pyramidMath";
import {
  FRAGMENT_SRC,
  GL_CONTEXT_OPTIONS,
  type GlCanvas,
  GlRaster,
  VERTEX_SRC,
} from "./rasterGl";
import { columnGeometry, premultiply } from "./shade";

/** A recording WebGL2 stand-in: jsdom has no WebGL. */
function fakeGl(opts: { compiles?: boolean; links?: boolean } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    (name: string, ret?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return ret;
    };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    TEXTURE0: 5,
    TEXTURE_2D: 6,
    TEXTURE_MIN_FILTER: 7,
    TEXTURE_MAG_FILTER: 8,
    NEAREST: 9,
    TEXTURE_WRAP_S: 10,
    TEXTURE_WRAP_T: 11,
    CLAMP_TO_EDGE: 12,
    BLEND: 13,
    RGBA32F: 14,
    RGBA: 15,
    FLOAT: 16,
    TRIANGLES: 17,
    UNSIGNED_BYTE: 18,
    createShader: record("createShader", {}),
    shaderSource: record("shaderSource"),
    compileShader: record("compileShader"),
    getShaderParameter: record("getShaderParameter", opts.compiles ?? true),
    deleteShader: record("deleteShader"),
    createProgram: record("createProgram", {}),
    createTexture: record("createTexture", {}),
    attachShader: record("attachShader"),
    linkProgram: record("linkProgram"),
    getProgramParameter: record("getProgramParameter", opts.links ?? true),
    useProgram: record("useProgram"),
    createVertexArray: record("createVertexArray", {}),
    bindVertexArray: record("bindVertexArray"),
    activeTexture: record("activeTexture"),
    bindTexture: record("bindTexture"),
    texParameteri: record("texParameteri"),
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    uniform1i: record("uniform1i"),
    uniform2f: record("uniform2f"),
    uniform4fv: record("uniform4fv"),
    disable: record("disable"),
    viewport: record("viewport"),
    texImage2D: record("texImage2D"),
    drawArrays: record("drawArrays"),
    readPixels: (
      _x: number,
      _y: number,
      w: number,
      h: number,
      _f: number,
      _t: number,
      out: Uint8Array,
    ) => {
      // Bottom row first: row index r holds value r in every byte.
      for (let r = 0; r < h; r++) {
        out.fill(r, r * w * 4, (r + 1) * w * 4);
      }
    },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

function canvasWith(gl: WebGL2RenderingContext | null) {
  const listeners: Record<string, () => void> = {};
  const getContext = vi.fn(() => gl);
  const canvas: GlCanvas = {
    width: 1,
    height: 1,
    getContext,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
  };
  return { canvas, listeners, getContext };
}

describe("GlRaster", () => {
  it("asks for the low-power premultiplied context", () => {
    const { gl } = fakeGl();
    const { canvas, getContext } = canvasWith(gl);
    expect(GlRaster.create(canvas)).not.toBeNull();
    expect(getContext).toHaveBeenCalledWith("webgl2", GL_CONTEXT_OPTIONS);
    expect(GL_CONTEXT_OPTIONS).toMatchObject({
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
    });
  });

  it("is null without WebGL2 or when shaders fail", () => {
    expect(GlRaster.create(canvasWith(null).canvas)).toBeNull();
    expect(
      GlRaster.create(canvasWith(fakeGl({ compiles: false }).gl).canvas),
    ).toBeNull();
    expect(
      GlRaster.create(canvasWith(fakeGl({ links: false }).gl).canvas),
    ).toBeNull();
  });

  it("uploads the shared geometry and premultiplied colours, then draws one triangle", () => {
    const { gl, calls } = fakeGl();
    const { canvas } = canvasWith(gl);
    const raster = GlRaster.create(canvas)!;
    const env = newEnvelope(3);
    env.has.fill(1);
    env.max.set([0.5, 0.9, 0.1]);
    env.min.set([-0.5, -0.2, -0.1]);
    env.rms.set([0.2, 0.3, 0.05]);
    const geom = columnGeometry(env, 1, 24, "pyramid");
    const core = new Float32Array([0.1, 0.2, 0.3, 1]);
    const edge = new Float32Array([0.4, 0.5, 0.6, 0.6]);
    raster.render(geom, 3, 24, core, edge);
    expect([canvas.width, canvas.height]).toEqual([3, 24]);
    const upload = calls.find((c) => c.name === "texImage2D")!;
    expect(upload.args.slice(2, 5)).toEqual([14, 3, 1]);
    expect(upload.args[8]).toBe(geom);
    const colours = calls.filter((c) => c.name === "uniform4fv");
    expect(colours.map((c) => [...(c.args[1] as Float32Array)])).toEqual([
      [...premultiply(core)],
      [...premultiply(edge)],
    ]);
    expect(calls.find((c) => c.name === "uniform2f")!.args.slice(1)).toEqual([
      3, 24,
    ]);
    expect(calls.find((c) => c.name === "drawArrays")!.args).toEqual([
      17, 0, 3,
    ]);
  });

  it("reads pixels back top row first", () => {
    const { gl } = fakeGl();
    const raster = GlRaster.create(canvasWith(gl).canvas)!;
    const px = raster.readTopDown(2, 3);
    expect(px[0]).toBe(2);
    expect(px[2 * 4 * 2]).toBe(0);
  });

  it("marks itself lost with the context", () => {
    const { gl } = fakeGl();
    const { canvas, listeners } = canvasWith(gl);
    const raster = GlRaster.create(canvas)!;
    listeners.webglcontextlost?.();
    expect(raster.lost).toBe(true);
  });

  it("shades with the shared formula: rowCoverage and premultiplied mix", () => {
    expect(FRAGMENT_SRC).toContain("precision highp float;");
    expect(FRAGMENT_SRC).toContain("precision highp sampler2D;");
    expect(FRAGMENT_SRC).toContain("max(0.0, min(y + 1.0, b) - max(y, a))");
    expect(FRAGMENT_SRC).toContain("uSize.y - gl_FragCoord.y - 0.5");
    expect(FRAGMENT_SRC).toContain("uCore * rc + uEdge * (pc - rc)");
    expect(FRAGMENT_SRC).toContain("texelFetch");
    expect(FRAGMENT_SRC).not.toContain("discard");
    expect(VERTEX_SRC).toContain("gl_VertexID");
  });
});
