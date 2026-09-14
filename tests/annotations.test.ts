import { describe, expect, it } from "vitest";
import { operations } from "../src/ops.js";

// R011: readOnly/destructive/idempotent annotations are a contract on EVERY operation,
// not a convention. This test asserts directly over the exported operations array so a
// future operation added without them fails here, not at review time.
// Note: survival of annotations through MCP tools/list is proven separately by the
// T04 MCP smoke script and the validate lane; this file only covers the source array.

describe("operations annotation contract", () => {
  it("has at least one operation (guards against a vacuous empty-array pass)", () => {
    expect(operations.length).toBeGreaterThan(0);
  });

  it.each(operations.map((op) => [op.name, op] as const))(
    "%s satisfies the read-only annotation contract",
    (_name, op) => {
      expect(op.annotations?.readOnlyHint).toBe(true);
      expect(op.annotations?.destructiveHint).toBe(false);
      expect(op.annotations?.idempotentHint).toBe(true);
      // Every operation in this toolkit calls the external GroupMe API, so
      // openWorldHint must be true for each (R011).
      expect(op.annotations?.openWorldHint).toBe(true);
    },
  );

  it.each(operations.map((op) => [op.name, op] as const))(
    "%s has non-empty name and description",
    (name, op) => {
      expect(name.trim().length).toBeGreaterThan(0);
      expect(op.name.trim().length).toBeGreaterThan(0);
      expect(op.description.trim().length).toBeGreaterThan(0);
    },
  );
});
