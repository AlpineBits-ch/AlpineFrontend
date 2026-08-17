/**
 * What the browser build says about itself.
 *
 * <p>The interesting cases are the two that are easy to get subtly wrong: an iPad reports a desktop
 * Safari UA and must not be mistaken for a Mac, and `kind` must stay `'web'` even on a phone - it names
 * the shell, while {@link OsInfo.isMobile} names the form factor. Confusing the two would have a phone
 * browser claiming a native host's capabilities.</p>
 */

import {version as packageVersion} from '../../../../package.json';
import {WebOsInfo} from './os-info.web';

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SAFARI_IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0';

/**
 * Replaces `navigator` wholesale rather than spying on a property.
 *
 * <p>`userAgent` and `maxTouchPoints` are prototype getters in jsdom, so a per-property spy is fragile;
 * a plain stand-in object is exactly what the adapter reads and nothing more.
 */
function stubNavigator(fields: {
    userAgent?: string;
    maxTouchPoints?: number;
    userAgentData?: {platform?: string; mobile?: boolean};
}): void {
    vi.stubGlobal('navigator', {
        userAgent: fields.userAgent ?? '',
        maxTouchPoints: fields.maxTouchPoints ?? 0,
        ...(fields.userAgentData ? {userAgentData: fields.userAgentData} : {}),
    });
}

afterEach(() => vi.unstubAllGlobals());

describe('WebOsInfo', () => {
    it('calls itself web, not the OS underneath', () => {
        stubNavigator({userAgent: CHROME_WINDOWS});

        expect(new WebOsInfo().kind).toBe('web');
    });

    it('stays web on a phone, while reporting the form factor separately', () => {
        stubNavigator({userAgent: FIREFOX_ANDROID});

        const os = new WebOsInfo();

        expect(os.kind).toBe('web');
        expect(os.isMobile).toBe(true);
    });

    it('is not mobile in a desktop browser', () => {
        stubNavigator({userAgent: CHROME_WINDOWS});

        expect(new WebOsInfo().isMobile).toBe(false);
    });

    /** Chromium states this outright, which beats reading a phone out of a UA string. */
    it('prefers the declared userAgentData.mobile flag over the UA string', () => {
        stubNavigator({userAgent: CHROME_WINDOWS, userAgentData: {platform: 'Windows', mobile: true}});

        expect(new WebOsInfo().isMobile).toBe(true);
    });

    /** iPadOS sends a desktop Safari UA. The touch screen is what a real Mac does not have. */
    it('counts an iPad as mobile despite its Macintosh user agent', () => {
        stubNavigator({userAgent: SAFARI_IPAD, maxTouchPoints: 5});

        expect(new WebOsInfo().isMobile).toBe(true);
    });

    it('does not count a Mac as mobile', () => {
        stubNavigator({userAgent: SAFARI_IPAD, maxTouchPoints: 0});

        expect(new WebOsInfo().isMobile).toBe(false);
    });

    it('names the product the same thing the desktop bundle does', async () => {
        stubNavigator({userAgent: CHROME_WINDOWS});

        expect(await new WebOsInfo().appName()).toBe('Venta');
    });

    /**
     * Read out of `package.json`, which `scripts/version-bump.js` moves in step with `tauri.conf.json`.
     * A literal here would drift, and it would drift somewhere that matters: this version is stamped into
     * the MLS key-backup envelope by `logout-dialog.component.ts`.
     */
    it('reports the version this bundle was built from', async () => {
        stubNavigator({userAgent: CHROME_WINDOWS});

        const reported = await new WebOsInfo().appVersion();

        expect(reported).toBe(packageVersion);
        expect(reported).toMatch(/^\d+\.\d+\.\d+/);
    });
});
