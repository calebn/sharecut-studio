import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSyntheticMicrophone,
  stubSyntheticMicrophone,
  syntheticMicrophoneRequested,
} from "./syntheticMicrophone";

const stream = { id: "synthetic" };

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "suspended";
  osc = { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn() };
  destination = { stream };
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  createOscillator = () => this.osc;
  createMediaStreamDestination = () => this.destination;
}

const original = {
  permissions: Object.getOwnPropertyDescriptor(navigator, "permissions"),
  mediaDevices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
};

function restore(name: keyof typeof original) {
  const descriptor = original[name];
  if (descriptor) {
    Object.defineProperty(navigator, name, descriptor);
  } else {
    delete (navigator as unknown as Record<string, unknown>)[name];
  }
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: async () => ({ state: "prompt" }) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  restore("permissions");
  restore("mediaDevices");
  delete (window as unknown as { __gumStubCalled?: boolean }).__gumStubCalled;
});

describe("installSyntheticMicrophone", () => {
  it("returns a live oscillator stream and records the request", async () => {
    installSyntheticMicrophone({ removePermissionsApi: false });

    await expect(
      navigator.mediaDevices.getUserMedia({ audio: true }),
    ).resolves.toBe(stream);
    const [ctx] = FakeAudioContext.instances;
    expect(ctx!.resume).toHaveBeenCalled();
    expect(ctx!.osc.frequency.value).toBe(440);
    expect(ctx!.osc.connect).toHaveBeenCalledWith(ctx!.destination);
    expect(ctx!.osc.start).toHaveBeenCalled();
    expect(
      (window as unknown as { __gumStubCalled?: boolean }).__gumStubCalled,
    ).toBe(true);
    await expect(navigator.mediaDevices.enumerateDevices()).resolves.toEqual(
      [],
    );
  });

  it("reuses one audio context across requests", async () => {
    installSyntheticMicrophone({ removePermissionsApi: false });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("keeps the native Permissions API unless asked to remove it", () => {
    installSyntheticMicrophone({ removePermissionsApi: false });
    expect(typeof navigator.permissions?.query).toBe("function");
    installSyntheticMicrophone({ removePermissionsApi: true });
    expect(navigator.permissions).toBeUndefined();
  });
});

describe("stubSyntheticMicrophone", () => {
  it("registers the installer with explicit defaults", async () => {
    const addInitScript = vi.fn(async () => undefined);
    await stubSyntheticMicrophone({ addInitScript } as never);
    await stubSyntheticMicrophone({ addInitScript } as never, {
      removePermissionsApi: true,
    });
    expect(addInitScript).toHaveBeenNthCalledWith(
      1,
      installSyntheticMicrophone,
      { removePermissionsApi: false },
    );
    expect(addInitScript).toHaveBeenNthCalledWith(
      2,
      installSyntheticMicrophone,
      { removePermissionsApi: true },
    );
  });

  it("reports whether the page requested the synthetic microphone", async () => {
    const page = {
      evaluate: vi.fn(async (fn: () => boolean) => fn()),
    };
    await expect(syntheticMicrophoneRequested(page as never)).resolves.toBe(
      false,
    );
    (window as unknown as { __gumStubCalled?: boolean }).__gumStubCalled = true;
    await expect(syntheticMicrophoneRequested(page as never)).resolves.toBe(
      true,
    );
  });
});
