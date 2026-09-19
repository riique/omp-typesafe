export interface Order {
	id: string;
	customerId: string;
	total: number;
}

/**
 * TODO: group orders by customerId. src/util.ts already exports a generic
 * groupBy() — use it instead of hand-rolling the grouping loop again.
 */
export function ordersByCustomer(orders: Order[]): Record<string, Order[]> {
	throw new Error("not implemented");
}
