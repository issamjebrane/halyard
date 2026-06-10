// Max signals a trader may post per calendar day (in their local timezone).
// Enforced authoritatively in the post_signal() SQL function; the UI mirrors it.
export const DAILY_SIGNAL_LIMIT = 10;
