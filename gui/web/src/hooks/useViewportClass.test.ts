import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cssViewportWidth,
  PHONE_MAX_PX,
  PHONE_MQ,
  shellBreakpointFromMatchMedia,
  shellBreakpointFromWidth,
  TABLET_MAX_PX,
  TABLET_MQ,
  useViewportClass,
} from "./useViewportClass";

describe("shellBreakpointFromWidth", () => {
  it("classifies phone", () => {
    expect(shellBreakpointFromWidth(0)).toBe("phone");
    expect(shellBreakpointFromWidth(PHONE_MAX_PX)).toBe("phone");
  });

  it("classifies tablet", () => {
    expect(shellBreakpointFromWidth(PHONE_MAX_PX + 1)).toBe("tablet");
    expect(shellBreakpointFromWidth(TABLET_MAX_PX)).toBe("tablet");
  });

  it("classifies desktop", () => {
    expect(shellBreakpointFromWidth(TABLET_MAX_PX + 1)).toBe("desktop");
    expect(shellBreakpointFromWidth(1920)).toBe("desktop");
  });
});

describe("shellBreakpointFromMatchMedia", () => {
  it("maps phone query to phone", () => {
    expect(shellBreakpointFromMatchMedia(true, true)).toBe("phone");
    expect(shellBreakpointFromMatchMedia(true, false)).toBe("phone");
  });

  it("maps tablet-only to tablet", () => {
    expect(shellBreakpointFromMatchMedia(false, true)).toBe("tablet");
  });

  it("maps neither to desktop", () => {
    expect(shellBreakpointFromMatchMedia(false, false)).toBe("desktop");
  });
});

describe("useViewportClass", () => {
  type Mq = {
    matches: boolean;
    media: string;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };

  let phoneMq: Mq;
  let tabletMq: Mq;

  beforeEach(() => {
    phoneMq = {
      matches: true,
      media: PHONE_MQ,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    tabletMq = {
      matches: true,
      media: TABLET_MQ,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => {
        if (query === PHONE_MQ) {
          return phoneMq;
        }
        if (query === TABLET_MQ) {
          return tabletMq;
        }
        return {
          matches: false,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns phone when the phone matchMedia query matches", () => {
    const { result } = renderHook(() => useViewportClass());
    expect(result.current).toBe("phone");
  });

  it("updates when matchMedia change fires", () => {
    const { result } = renderHook(() => useViewportClass());
    expect(result.current).toBe("phone");

    phoneMq.matches = false;
    tabletMq.matches = true;
    const changeHandler = phoneMq.addEventListener.mock.calls.find(
      (c) => c[0] === "change",
    )?.[1] as (() => void) | undefined;
    expect(changeHandler).toBeTypeOf("function");
    act(() => {
      changeHandler?.();
    });
    expect(result.current).toBe("tablet");
  });

  it("tracks visualViewport resize and releases extra listeners on unmount", () => {
    const resizeListeners = new Set<() => void>();
    const visualViewport = {
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        resizeListeners.add(listener);
      }),
      removeEventListener: vi.fn((_event: string, listener: () => void) => {
        resizeListeners.delete(listener);
      }),
    };
    vi.stubGlobal("visualViewport", visualViewport);
    const { result, unmount } = renderHook(() => useViewportClass());
    expect(result.current).toBe("phone");

    phoneMq.matches = false;
    tabletMq.matches = false;
    act(() => {
      for (const listener of resizeListeners) listener();
    });
    expect(result.current).toBe("desktop");

    unmount();
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function),
    );
    expect(resizeListeners.size).toBe(0);
    expect(phoneMq.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    expect(tabletMq.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });

  it("hydrates from the server shell and then reads the client breakpoint", () => {
    function ShellLabel() {
      return createElement("span", null, useViewportClass());
    }
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(ShellLabel));
    expect(container.textContent).toBe("desktop");
    document.body.append(container);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    act(() => {
      root = hydrateRoot(container, createElement(ShellLabel));
    });
    expect(container.textContent).toBe("phone");
    act(() => root?.unmount());
    container.remove();
  });
});

describe("cssViewportWidth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers visualViewport width over innerWidth", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("visualViewport", { width: 390 });
    expect(cssViewportWidth()).toBe(390);
  });

  it("falls back to innerWidth when visualViewport is missing", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal("visualViewport", null);
    expect(cssViewportWidth()).toBe(1440);
  });
});
