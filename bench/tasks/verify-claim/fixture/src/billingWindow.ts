/**
 * Returns true if `day` (1-31) falls within the billing window that starts
 * on `windowStart` and runs for `windowLenDays` days, wrapping past the end
 * of the month.
 *
 * Bug: for a wrapping window (e.g. start=28, len=5 -> covers 28,29,30,31,1,2)
 * this off-by-one currently excludes the start day itself when the window
 * wraps. Naive fix attempt: changing `>` to `>=` on the first branch looks
 * right but actually breaks the non-wrapping case (it was already correct);
 * the real bug is the wrap branch's upper bound being exclusive when it
 * should be inclusive of day `windowLenDays - (32 - windowStart)`.
 */
export function inBillingWindow(day: number, windowStart: number, windowLenDays: number): boolean {
	const windowEnd = windowStart + windowLenDays - 1;
	if (windowEnd <= 31) {
		return day >= windowStart && day <= windowEnd;
	}
	// wraps past the end of the month
	const wrapEnd = windowEnd - 31;
	return day >= windowStart || day < wrapEnd;
}
