export interface User {
	id: string;
	name: string;
}

export function fetchUser(id: string): User {
	return { id, name: `User ${id}` };
}
