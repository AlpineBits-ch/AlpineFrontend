/**
 * The one place a `DeviceType` is decided.
 *
 * <p><b>Why this file exists now.</b> There were two code paths and they disagreed. This one branches
 * on the host and answers `Web` for any browser; `DeviceRegistrationModalComponent` computed its own
 * as `isMobile ? Mobile : Desktop` and could not answer `Web` at all. That was already wrong - a
 * browser registered as Desktop - and it got worse when `isMobile` moved from `PlatformService` (false
 * for everything outside Tauri) to `OsInfo` (a true form factor), because a *phone browser* then
 * registered as Mobile.</p>
 *
 * <p>It is not cosmetic. The backend picks a push transport off `deviceType`, and the phone app is a
 * separate Flutter client, so a browser claiming `Mobile` would be routed at FCM/APNs instead of Web
 * Push - notifications would stop with nothing reporting it.</p>
 *
 * <p>The host is passed rather than faked by defining `__TAURI_INTERNALS__` on `globalThis`: that is a
 * boundary breach `platform-boundary.spec.ts` now catches in specs too, and it would have been testing
 * `detectHost()` rather than this rule. Same pattern as `useRustPublisher`.</p>
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {describeCurrentDevice} from './device-description';
import {DeviceType} from '../dtos/response/user-device.dto';

const CHROME_WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/128.0.0.0 Safari/537.36';

const SAFARI_IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
    'Version/17.5 Mobile/15E148 Safari/604.1';

const CHROME_ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/128.0.0.0 Mobile Safari/537.36';

/**
 * Replaces `navigator` wholesale rather than spying on a property - `userAgent` and `maxTouchPoints`
 * are prototype getters in jsdom, so a per-property spy is fragile. Same stand-in, same reason, as in
 * `platform/web/os-info.web.spec.ts`.
 */
function stubNavigator(userAgent: string, maxTouchPoints = 0): void {
    vi.stubGlobal('navigator', {userAgent, maxTouchPoints});
}

afterEach(() => vi.unstubAllGlobals());

describe('describeCurrentDevice deviceType', () => {
    it('is Desktop on the Tauri shell', () => {
        stubNavigator(CHROME_WINDOWS);

        expect(describeCurrentDevice('tauri').deviceType).toBe(DeviceType.Desktop);
    });

    it('is Web in a desktop browser, not Desktop', () => {
        // The half that was already wrong before `isMobile` changed meaning: a browser is not a
        // desktop app, and the server routes push off the difference.
        stubNavigator(CHROME_WINDOWS);

        expect(describeCurrentDevice('web').deviceType).toBe(DeviceType.Web);
    });

    it('is Web in a phone browser, not Mobile', () => {
        // The regression the modal would otherwise have shipped. `Mobile` here means the Flutter app,
        // which mints its own registration; a browser claiming it asks for a transport it cannot
        // receive on.
        stubNavigator(SAFARI_IPHONE, 5);

        expect(describeCurrentDevice('web').deviceType).toBe(DeviceType.Web);
    });

    it('is Web in an Android browser too, so the answer is the host and not the OS', () => {
        stubNavigator(CHROME_ANDROID, 5);

        expect(describeCurrentDevice('web').deviceType).toBe(DeviceType.Web);
    });

    /**
     * Tauri mobile is not reachable: the crate is `crate-type = ["rlib"]`, desktop-only, and the phone
     * app is a separate Flutter client. So there is no host/form-factor pair that should produce
     * `Mobile` from here, and this asserts the whole matrix rather than one case - it is what would go
     * red if someone reintroduced a form-factor branch in a caller.
     */
    it('never reports Mobile, on any host or user agent', () => {
        for (const host of ['tauri', 'web'] as const) {
            for (const ua of [CHROME_WINDOWS, SAFARI_IPHONE, CHROME_ANDROID]) {
                stubNavigator(ua, 5);
                expect(
                    describeCurrentDevice(host).deviceType,
                    `${host} + ${ua.slice(0, 40)} produced Mobile`,
                ).not.toBe(DeviceType.Mobile);
            }
        }
    });

    it('defaults to asking the host itself, which under the runner is a browser', () => {
        // The parameter existing must not change what a bare call means - every caller makes one.
        stubNavigator(CHROME_WINDOWS);

        expect(describeCurrentDevice().deviceType).toBe(describeCurrentDevice('web').deviceType);
    });
});

describe('describeCurrentDevice deviceName', () => {
    it('names the browser and the OS under it in a browser', () => {
        stubNavigator(SAFARI_IPHONE, 5);

        expect(describeCurrentDevice('web').deviceName).toBe('Safari on iOS');
    });

    it('names the desktop app on the Tauri shell', () => {
        stubNavigator(CHROME_WINDOWS);

        expect(describeCurrentDevice('tauri').deviceName).toBe('Venta Desktop on Windows');
    });
});
