import {DeviceType} from '../dtos/response/user-device.dto';
import {detectHost, PlatformHost} from '../platform/host';

/** The parts of this device's identity that are safe to derive without any I/O. */
export interface DeviceDescription {
    /** Human-readable label shown to an approving phone and later in the sessions list. */
    deviceName: string;
    deviceType: DeviceType;
}

/**
 * Best-effort label for the sessions list, device registration and the phone's confirmation
 * prompt. Parsed from the user agent rather than a native API so it works identically in the
 * browser and inside the Tauri webview, where a failed plugin call would otherwise leave the
 * phone approving an anonymous "unknown device".
 *
 * Lives in its own module rather than beside its first caller: `DeviceIdentityService`,
 * `QrLoginService`, `AuthService` and `DeviceRegistrationModalComponent` all need it, and the first
 * two also depend on each other through DI - importing it from either would close an import cycle.
 *
 * <p><b>This is the only place a `DeviceType` is decided, and that is load-bearing rather than
 * tidy.</b> The registration modal used to compute its own as
 * `isMobile ? Mobile : Desktop`, which never returned {@link DeviceType.Web} at all - so a browser
 * registered as Desktop, and once `isMobile` became a true form-factor read a *phone browser*
 * registered as Mobile. The backend picks a push transport off this field, so that second one would
 * have routed mobile web at FCM/APNs instead of Web Push and dropped every notification silently.</p>
 *
 * <p><b>The host decides first, and form factor plays no part.</b> Any browser is
 * {@link DeviceType.Web} whatever it is running on. {@link DeviceType.Mobile} is <b>never</b> produced
 * here, because it is not this client's to send: Tauri mobile is not built from this crate - see the
 * `crate-type = ["rlib"]` note in `src-tauri/Cargo.toml` - and the phone app is a separate Flutter
 * client that reports `Mobile` for itself. If a Tauri mobile target ever comes back, the form-factor
 * branch belongs *here*, where all four callers pick it up together, and not in one of them.</p>
 *
 * @param host defaults to {@link detectHost}, and every caller leaves it out. It is a parameter only
 *        so a spec can exercise both branches without defining `__TAURI_INTERNALS__` on `globalThis`,
 *        which `platform-boundary.spec.ts` counts as reaching around the ports. Passing it also keeps
 *        the global read in exactly one place - the `typeof window` guard lives there too.
 */
export function describeCurrentDevice(host: PlatformHost = detectHost()): DeviceDescription {
    const os = detectOs();

    if (host === 'tauri') {
        return {deviceName: `Venta Desktop on ${os}`, deviceType: DeviceType.Desktop};
    }
    return {deviceName: `${detectBrowser()} on ${os}`, deviceType: DeviceType.Web};
}

function detectOs(): string {
    const ua = navigator.userAgent;
    if (/Windows NT 1[01]/.test(ua)) return 'Windows';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Android/.test(ua)) return 'Android';
    // iPadOS reports as Macintosh; the touch-point check is the standard way to tell them apart.
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
    if (/Mac OS X/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPadOS' : 'macOS';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Unknown OS';
}

function detectBrowser(): string {
    const ua = navigator.userAgent;
    // Order matters: every Chromium browser also claims "Chrome", and Chrome claims "Safari".
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'Browser';
}
