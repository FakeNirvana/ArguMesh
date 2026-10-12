import { expect, it } from "vitest";
import { evidencePageNumber, canBatchConfirm } from "../../src/matrix/review";

const cell = { status: "draft" as const, locked: false, value: "Conclusion", claim: "Claim", sourcePage: "第 3 页", sourceExcerpt: "Source quote" };
it("批量确认只接纳有原文与位置的草稿", () => {
  expect(canBatchConfirm(cell)).toBe(true);
  for (const status of ["missing", "conflict", "confirmed"] as const) expect(canBatchConfirm({ ...cell, status })).toBe(false);
  expect(canBatchConfirm({ ...cell, locked: true })).toBe(false);
  expect(canBatchConfirm({ ...cell, value: "待提取" })).toBe(false);
  expect(canBatchConfirm({ ...cell, sourceExcerpt: " " })).toBe(false);
  expect(canBatchConfirm({ ...cell, sourcePage: "—" })).toBe(false);
});

it.each([ ["第 3 页", 3], ["3", 3], ["p. 12", 12], ["page 4", 4], ["3–4", 3], ["0", null], ["—", null], ["Results 3", null] ])("证据页码 %s → %s", (label, expected) => {
  expect(evidencePageNumber(String(label))).toBe(expected);
});
