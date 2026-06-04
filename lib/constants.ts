// Max signals a trader may post per UTC calendar day. Enforced authoritatively
// in the post_signal() SQL function; the UI mirrors it for feedback.
export const DAILY_SIGNAL_LIMIT = 5;
