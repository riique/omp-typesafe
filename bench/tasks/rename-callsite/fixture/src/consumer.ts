// Imports fetchUser through the barrel re-export in ./index, not directly
// from ./user or ./api. A grep limited to direct importers of ./user misses
// this callsite.
import { fetchUser } from "./index";

export function consumerGetUser(id: string): string {
	return fetchUser(id).name;
}
