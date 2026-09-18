import { expect, test } from "bun:test";
import { consumerGetUser } from "../src/consumer";

test("consumerGetUser resolves through the barrel re-export", () => {
	expect(consumerGetUser("42")).toBe("User 42");
});
