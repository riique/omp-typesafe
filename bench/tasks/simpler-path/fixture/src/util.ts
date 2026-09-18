/** Groups items of an array by a key function. Already exists — reuse it. */
export function groupBy<T, K extends string | number>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
	const out = {} as Record<K, T[]>;
	for (const item of items) {
		const key = keyFn(item);
		(out[key] ??= []).push(item);
	}
	return out;
}
