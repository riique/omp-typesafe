import { describe, expect, test } from "bun:test";
import { applyEnvOverrides, DEFAULT_CONFIG, mergeConfig, resolveConfigPath } from "../src/config";
import type { TypesafeConfig } from "../src/config";

/**
 * config.ts unit tests: role/phases parsing in mergeConfig, env override precedence in
 * applyEnvOverrides, and TYPESAFE_CONFIG path selection. No disk or network access.
 */

describe("mergeConfig — role and phases", () => {
	test("parses a valid role and phases from the override object", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { role: "advisory", phases: ["plan"] });
		expect(cfg.role).toBe("advisory");
		expect(cfg.phases).toEqual(["plan"]);
	});

	test("falls back to base role on an invalid value", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { role: "bogus" });
		expect(cfg.role).toBe(DEFAULT_CONFIG.role);
	});

	test("falls back to base phases when phases is not an array", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { phases: "plan" });
		expect(cfg.phases).toEqual(DEFAULT_CONFIG.phases);
	});

	test("falls back to base phases when the array has no valid entries", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { phases: ["bogus", 42, null] });
		expect(cfg.phases).toEqual(DEFAULT_CONFIG.phases);
	});

	test("dedupes valid phase entries", () => {
		const cfg = mergeConfig(DEFAULT_CONFIG, { phases: ["plan", "plan", "execute"] });
		expect(cfg.phases).toEqual(["plan", "execute"]);
	});

	test("default config has role adversarial and both phases", () => {
		expect(DEFAULT_CONFIG.role).toBe("adversarial");
		expect(DEFAULT_CONFIG.phases).toEqual(["plan", "execute"]);
	});
});

describe("applyEnvOverrides", () => {
	function baseCfg(overrides: Partial<TypesafeConfig> = {}): TypesafeConfig {
		return { ...DEFAULT_CONFIG, ...overrides, adversary: { ...DEFAULT_CONFIG.adversary, ...overrides.adversary } };
	}

	test("TYPESAFE_ROLE=advisory flips role", () => {
		const out = applyEnvOverrides(baseCfg(), { TYPESAFE_ROLE: "advisory" });
		expect(out.role).toBe("advisory");
	});

	test("TYPESAFE_ROLE=adversarial flips role back", () => {
		const out = applyEnvOverrides(baseCfg({ role: "advisory" }), { TYPESAFE_ROLE: "adversarial" });
		expect(out.role).toBe("adversarial");
	});

	test("an unrecognized TYPESAFE_ROLE value is a no-op", () => {
		const out = applyEnvOverrides(baseCfg(), { TYPESAFE_ROLE: "bogus" });
		expect(out.role).toBe(DEFAULT_CONFIG.role);
	});

	test.each(["0", "false", "FALSE", "False"])("TYPESAFE_REVIEW_ENABLED=%s disables review", (value) => {
		const cfg = baseCfg({ adversary: { ...DEFAULT_CONFIG.adversary, enabled: true } });
		const out = applyEnvOverrides(cfg, { TYPESAFE_REVIEW_ENABLED: value });
		expect(out.adversary.enabled).toBe(false);
	});

	test.each(["1", "true", "TRUE", "True"])("TYPESAFE_REVIEW_ENABLED=%s enables review", (value) => {
		const cfg = baseCfg({ adversary: { ...DEFAULT_CONFIG.adversary, enabled: false } });
		const out = applyEnvOverrides(cfg, { TYPESAFE_REVIEW_ENABLED: value });
		expect(out.adversary.enabled).toBe(true);
	});

	test("an unrecognized TYPESAFE_REVIEW_ENABLED value is a no-op", () => {
		const cfg = baseCfg({ adversary: { ...DEFAULT_CONFIG.adversary, enabled: true } });
		const out = applyEnvOverrides(cfg, { TYPESAFE_REVIEW_ENABLED: "maybe" });
		expect(out.adversary.enabled).toBe(true);
	});

	test("env wins over a file-derived value: file says enabled, env disables", () => {
		const fromFile = mergeConfig(DEFAULT_CONFIG, { adversary: { enabled: true } });
		expect(fromFile.adversary.enabled).toBe(true);
		const out = applyEnvOverrides(fromFile, { TYPESAFE_REVIEW_ENABLED: "0" });
		expect(out.adversary.enabled).toBe(false);
	});

	test("no relevant env vars leaves the config untouched", () => {
		const cfg = baseCfg();
		const out = applyEnvOverrides(cfg, {});
		expect(out).toEqual(cfg);
	});
});

describe("resolveConfigPath", () => {
	test("uses TYPESAFE_CONFIG when set", () => {
		expect(resolveConfigPath({ TYPESAFE_CONFIG: "/tmp/alt-typesafe.json" })).toBe("/tmp/alt-typesafe.json");
	});

	test("ignores a blank TYPESAFE_CONFIG and falls back to the default path", () => {
		const path = resolveConfigPath({ TYPESAFE_CONFIG: "   " });
		expect(path.endsWith("typesafe.json")).toBe(true);
		expect(path).not.toBe("   ");
	});

	test("falls back to the default path when unset", () => {
		const path = resolveConfigPath({});
		expect(path).toContain(".omp");
		expect(path.endsWith("typesafe.json")).toBe(true);
	});
});
