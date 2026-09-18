import { expect, test } from "bun:test";
import { ordersByCustomer } from "../src/orders";

const orders = [
	{ id: "o1", customerId: "c1", total: 10 },
	{ id: "o2", customerId: "c2", total: 20 },
	{ id: "o3", customerId: "c1", total: 30 },
];

test("ordersByCustomer groups orders by customerId", () => {
	const grouped = ordersByCustomer(orders);
	expect(grouped.c1.map((o) => o.id)).toEqual(["o1", "o3"]);
	expect(grouped.c2.map((o) => o.id)).toEqual(["o2"]);
});
