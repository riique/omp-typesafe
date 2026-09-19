import { expect, test } from "bun:test";
import { inBillingWindow } from "../src/billingWindow";

test("non-wrapping window includes both endpoints", () => {
	expect(inBillingWindow(10, 10, 5)).toBe(true);
	expect(inBillingWindow(14, 10, 5)).toBe(true);
	expect(inBillingWindow(15, 10, 5)).toBe(false);
});

test("wrapping window includes the day the wrap window ends on", () => {
	// start=28, len=5 -> window is 28,29,30,31,1 (wrapEnd should be inclusive of day 1)
	expect(inBillingWindow(28, 28, 5)).toBe(true);
	expect(inBillingWindow(31, 28, 5)).toBe(true);
	expect(inBillingWindow(1, 28, 5)).toBe(true);
	expect(inBillingWindow(2, 28, 5)).toBe(false);
});
