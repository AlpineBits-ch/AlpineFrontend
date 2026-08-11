/**
 * Guessing the operating system from what the browser will tell us.
 *
 * <p>Shared by both {@code OsInfo} adapters, for different reasons. The web adapter has nothing else
 * to go on. The Tauri adapter has the OS plugin's injected global and only falls back here when that
 * global is missing - which must not answer {@code 'web'}, because a desktop build that mis-reports
 * itself as a browser would switch off features it actually has.</p>
 *
 * <p><b>This is a guess and is treated as one.</b> {@link sniffOsFamily} returns null rather than a
 * default when nothing matches, so a caller decides what an unknown OS means instead of inheriting
 * "Linux" by accident. Every value here is user-controlled - a UA string is a request header the
 * client sets - so nothing security-relevant may hang off it.</p>
 */

/** The desktop and phone families {@code OsInfo.kind} can name. Excludes {@code 'web'} by design. */
export type OsFamily = 'windows' | 'macos' | 'linux' | 'ios' | 'android';

/**
 * The subset of `NavigatorUAData` this module reads.
 *
 * <p>Declared locally because `navigator.userAgentData` is Chromium-only and absent from the DOM lib
 * this project compiles against. Both fields are optional: Firefox and Safari have no
 * {@code userAgentData} at all, so every read below is guarded rather than assumed.</p>
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
 * <p>`userAgentData.platform` is preferred where it exists: it is a short declared value ("Windows",
 * "macOS") rather than a string to be pattern-matched, and it survives the UA reduction Chromium is
 * freezing the legacy header into. The UA string is the fallback for Firefox and Safari.</p>
 *
 * <p>iPad is why the iOS test looks the way it does. iPadOS reports a desktop Safari UA with
 * "Macintosh" in it and no "iPad", so it is separated from a real Mac by the one thing a Mac does not
 * have: a touch screen. Getting this wrong the other way - calling an iPad a Mac - would mean
 * offering it desktop-only affordances that silently do nothing.</p>
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

/**
 * Whether this is a phone or tablet, as a form factor rather than as an OS.
 *
 * <p>Kept separate from {@link sniffOsFamily} because the two answer different questions and a
 * browser can answer the first without the second: Chromium reports {@code userAgentData.mobile}
 * directly, and that is more reliable than reading a phone out of a UA string.</p>
 */
export function sniffIsMobile(): boolean {
    const declared = userAgentData()?.mobile;
    if (typeof declared === 'boolean') return declared;

    const family = sniffOsFamily();
    if (family === 'android' || family === 'ios') return true;
    return /Mobile|Tablet/i.test(userAgentString());
}
