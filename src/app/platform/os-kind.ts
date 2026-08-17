/**
 * Guessing the operating system from what the browser will tell us. Shared by both `OsInfo` adapters.
 *
 * This is a guess: {@link sniffOsFamily} returns null rather than defaulting, and every value here
 * is user-controlled, so nothing security-relevant may hang off it.
 */

/** The desktop and phone families {@code OsInfo.kind} can name. Excludes {@code 'web'} by design. */
export type OsFamily = 'windows' | 'macos' | 'linux' | 'ios' | 'android';

/**
 * The subset of `NavigatorUAData` this module reads. Declared locally: it is Chromium-only and
 * absent from the DOM lib. Both fields are optional, so every read below must stay guarded.
 */
interface UserAgentData {
    readonly platform?: string;
    readonly mobile?: boolean;
}

function userAgentData(): UserAgentData | undefined {
    if (typeof navigator === 'undefined') return undefined;
    return (navigator as unknown as {userAgentData?: UserAgentData}).userAgentData;
}

function userAgentString(): string {
    if (typeof navigator === 'undefined') return '';
    return navigator.userAgent ?? '';
}

/**
 * Which OS family this is running on, or null when nothing recognisable said.
 *
 * `userAgentData.platform` is preferred where it exists; the UA string is the Firefox/Safari
 * fallback. iPadOS reports a "Macintosh" UA, so it is told from a real Mac by the touch screen.
 */
export function sniffOsFamily(): OsFamily | null {
    const declared = userAgentData()?.platform;
    if (declared) {
        const family = familyFromDeclaredPlatform(declared);
        if (family) return family;
    }

    const ua = userAgentString();
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Macintosh|Mac OS X/i.test(ua)) return isTouchMac() ? 'ios' : 'macos';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
    return null;
}

function familyFromDeclaredPlatform(platform: string): OsFamily | null {
    switch (platform.toLowerCase()) {
        case 'windows':
            return 'windows';
        case 'macos':
            return isTouchMac() ? 'ios' : 'macos';
        case 'android':
            return 'android';
        case 'ios':
            return 'ios';
        case 'linux':
        case 'chrome os':
        case 'chromium os':
            return 'linux';
        default:
            return null;
    }
}

/** A "Mac" with a touch screen is an iPad. `maxTouchPoints` is 0 on every real Mac. */
function isTouchMac(): boolean {
    return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1;
}

/** Whether this is a phone or tablet, as a form factor rather than as an OS. */
export function sniffIsMobile(): boolean {
    const declared = userAgentData()?.mobile;
    if (typeof declared === 'boolean') return declared;

    const family = sniffOsFamily();
    if (family === 'android' || family === 'ios') return true;
    return /Mobile|Tablet/i.test(userAgentString());
}
