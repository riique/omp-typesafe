import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

test("short -v flag still enables verbose mode", () => {
	expect(parseArgs(["-v", "build"])).toEqual({ verbose: true, rest: ["build"] });
});

test("long --verbose flag also enables verbose mode", () => {
	expect(parseArgs(["--verbose", "build"])).toEqual({ verbose: true, rest: ["build"] });
});

test("no flag leaves verbose off", () => {
	expect(parseArgs(["build"])).toEqual({ verbose: false, rest: ["build"] });
});
