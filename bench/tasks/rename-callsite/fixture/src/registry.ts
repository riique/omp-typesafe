import { fetchUser } from "./user";

// Keyed dispatch table; consumers look up loaders by name at runtime rather
// than importing the function directly.
export const loaders: Record<string, (id: string) => { id: string; name: string }> = {
	fetchUser,
};
