import { afterEach, describe, expect, it, vi } from "vitest";
import { markRoleHintSeen, type RoleHintRole, roleHintSeen } from "./roleHint";

const ROLES: RoleHintRole[] = ["viewer", "commenter", "editor"];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const role of ROLES) {
    localStorage.removeItem(`sharecut.roleHintSeen.${role}`);
  }
});

describe("the role hint's memory", () => {
  it("is unseen by default", () => {
    for (const role of ROLES) expect(roleHintSeen(role)).toBe(false);
  });

  it("is seen once marked, under that role's key", () => {
    markRoleHintSeen("viewer");
    expect(roleHintSeen("viewer")).toBe(true);
    expect(localStorage.getItem("sharecut.roleHintSeen.viewer")).toBe("1");
  });

  it("keeps each role independent", () => {
    markRoleHintSeen("commenter");
    expect(roleHintSeen("commenter")).toBe(true);
    expect(roleHintSeen("viewer")).toBe(false);
    expect(roleHintSeen("editor")).toBe(false);
  });

  it("is forgotten, not thrown, where storage is blocked", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(() => markRoleHintSeen("editor")).not.toThrow();
    expect(roleHintSeen("editor")).toBe(false);
  });
});
