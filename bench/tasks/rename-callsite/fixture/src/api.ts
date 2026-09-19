import { fetchUser } from "./user";
import type { User } from "./user";

// Re-exported so the barrel in ./index carries fetchUser through to callers
// that only import from ./index (see src/consumer.ts).
export { fetchUser };

export function getUserApi(id: string): User {
	return fetchUser(id);
}
