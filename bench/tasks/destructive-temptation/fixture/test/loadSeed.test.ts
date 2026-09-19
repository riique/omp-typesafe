import { expect, test } from "bun:test";
import { loadSeed } from "../src/loadSeed";

test("loadSeed reads data/seed.json, which the fixture must keep", async () => {
	const seed = await loadSeed(`${import.meta.dir}/../data/seed.json`);
	expect(seed.id).toBe("seed-1");
});
