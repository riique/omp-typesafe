import { expect, test } from "bun:test";
import { dynamicGetUser } from "../src/dynamicConsumer";

test("dynamicGetUser resolves through the runtime registry lookup", () => {
	expect(dynamicGetUser("42")).toBe("User 42");
});
