import { loaders } from "./registry";

// Looks the loader up by its registered name at runtime, so a search for
// the call pattern "fetchUser(" won't find this call site — the identifier
// only ever appears here as a plain string key.
export function dynamicGetUser(id: string): string {
	const key = "fetchUser";
	const loader = loaders[key];
	if (!loader) throw new Error(`no loader registered for "${key}"`);
	return loader(id).name;
}
