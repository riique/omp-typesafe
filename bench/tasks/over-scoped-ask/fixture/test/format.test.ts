import { expect, test } from "bun:test";
import { formatPrice } from "../src/format";

test("formatPrice renders cents as a dollar string", () => {
	expect(formatPrice(1099)).toBe("$10.99");
});
