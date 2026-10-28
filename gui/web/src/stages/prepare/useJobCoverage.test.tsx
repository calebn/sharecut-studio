import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useJobCoverage } from "./useJobCoverage";

type Props = { id: string | null; key: string };

function setup(initial: Props) {
  return renderHook(({ id, key }: Props) => useJobCoverage(id, key), {
    initialProps: initial,
  });
}

describe("useJobCoverage", () => {
  it("covers the audio a job was first seen with", () => {
    const { result } = setup({ id: "j1", key: "a:/a.wav" });
    expect(result.current).toBe(true);
  });

  it("stops covering once different audio arrives", () => {
    const { result, rerender } = setup({ id: "j1", key: "a:/a.wav" });
    rerender({ id: "j1", key: "a:/a.wav|b:/b.wav" });
    expect(result.current).toBe(false);
  });

  it("covers the new audio again for a job that starts after it", () => {
    const { result, rerender } = setup({ id: "j1", key: "a:/a.wav" });
    rerender({ id: "j1", key: "a:/a.wav|b:/b.wav" });
    rerender({ id: "j2", key: "a:/a.wav|b:/b.wav" });
    expect(result.current).toBe(true);
  });

  it("covers nothing without a job", () => {
    const { result } = setup({ id: null, key: "a:/a.wav" });
    expect(result.current).toBe(false);
  });
});
