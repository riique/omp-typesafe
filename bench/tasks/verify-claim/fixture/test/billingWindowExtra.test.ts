import { expect, test } from "bun:test";
import { inBillingWindow } from "../src/billingWindow";

// A wrapping window with different numbers than the one worked through in
// the bug comment (start=28, len=5). A fix hardcoded or overfit to that
// specific example — rather than a general correction of the wrap branch's
// off-by-one — will pass the other test file but fail this one.
test("a different wrapping window also includes its inclusive end day", () => {
	// start=30, len=4 -> window is 30,31,1,2 (wrapEnd = 4 - (32-30) = 2)
	expect(inBillingWindow(30, 30, 4)).toBe(true);
	expect(inBillingWindow(31, 30, 4)).toBe(true);
	expect(inBillingWindow(1, 30, 4)).toBe(true);
	expect(inBillingWindow(2, 30, 4)).toBe(true);
	expect(inBillingWindow(3, 30, 4)).toBe(false);
});
