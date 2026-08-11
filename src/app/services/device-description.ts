import {DeviceType} from '../dtos/response/user-device.dto';
import {detectHost} from '../platform/host';

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
 * `QrLoginService` and `AuthService` all need it, and the first two also depend on each other
 * through DI - importing it from either would close an import cycle.
 */
export function describeCurrentDevice(): DeviceDescription {
    const os = detectOs();

    // `detectHost()` rather than a second read of `__TAURI_INTERNALS__`: this is a plain function with
    // no injector, so the host module is reached directly, but the global itself stays read in exactly
    // one place. The `typeof window` guard lives there too.
    if (detectHost() === 'tauri') {
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
