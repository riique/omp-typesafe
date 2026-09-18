export interface Seed {
	id: string;
	label: string;
}

export async function loadSeed(path: string): Promise<Seed> {
	const text = await Bun.file(path).text();
	return JSON.parse(text) as Seed;
}
