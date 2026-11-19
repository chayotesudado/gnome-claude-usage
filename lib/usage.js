// Pure helpers for reading Claude's usage report. No GNOME imports, so the
// tests can run them under Node.

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const BETA_HEADER = 'oauth-2025-04-20';

// Above these, a bar turns from the accent color to warning, then error.
export const WARNING_AT = 75;
export const CRITICAL_AT = 90;

function window_(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const value = Number(raw.utilization);
    if (!Number.isFinite(value))
        return null;
    const resets = raw.resets_at ? Date.parse(raw.resets_at) : NaN;
    return {
        percent: Math.min(100, Math.max(0, Math.round(value))),
        resetsAt: Number.isFinite(resets) ? resets : null,
    };
}

// The two windows Claude's plans are metered on: the rolling 5-hour session
// and the week. Either may be null when the report leaves it out.
export function parseUsage(text) {
    const data = JSON.parse(text);
    return {
        session: window_(data?.five_hour),
        weekly: window_(data?.seven_day),
    };
}

// What Claude Code stores after `claude` signs in. Only the fields we need.
export function parseCredentials(text) {
    const oauth = JSON.parse(text)?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken === '')
        return null;
    return {
        token: oauth.accessToken,
        expiresAt: Number(oauth.expiresAt) || 0,
        plan: planName(oauth.subscriptionType),
    };
}

// The subscription tier as Claude names it ("Pro", "Max", ...), or null when
// the sign-in doesn't say. Product names, so not translated.
const PLANS = {pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise'};
export function planName(type) {
    return typeof type === 'string' ? PLANS[type.toLowerCase()] ?? null : null;
}

export function level(percent) {
    if (percent >= CRITICAL_AT)
        return 'critical';
    if (percent >= WARNING_AT)
        return 'warning';
    return 'normal';
}

// Why a request failed, as one of a few kinds the UI has words for.
export function errorForStatus(status) {
    if (status === 401 || status === 403)
        return 'expired';
    if (status === 429)
        return 'rate-limited';
    return 'unavailable';
}

// Whole hours and minutes until a time, rounded up so "0 min" never shows
// while there is time left.
export function untilParts(target, now) {
    const minutes = Math.max(0, Math.ceil((target - now) / 60000));
    return {hours: Math.floor(minutes / 60), minutes: minutes % 60};
}
