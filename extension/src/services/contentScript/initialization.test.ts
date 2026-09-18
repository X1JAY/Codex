import { describe, expect, it, vi } from "vitest";
import { initializeContentScriptOnce } from "./initialization";

describe("content-script initialization guard", () => {
  it("registers listeners once when the same bundle is injected repeatedly", () => {
    const scope: Record<string, unknown> = {};
    const register = vi.fn();

    expect(initializeContentScriptOnce(scope, register)).toBe(true);
    expect(initializeContentScriptOnce(scope, register)).toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("clears the marker when listener registration throws", () => {
    const scope: Record<string, unknown> = {};
    expect(() => initializeContentScriptOnce(scope, () => { throw new Error("register failed"); }))
      .toThrow("register failed");
    expect(initializeContentScriptOnce(scope, () => undefined)).toBe(true);
  });
});

