import {detectHost, PlatformHost} from './host';
import {MediaDeviceSource} from './ports/media-devices.port';
import {TauriMediaDeviceSource} from './tauri/media-devices.tauri';
import {WebMediaDeviceSource} from './web/media-devices.web';

/** The {@link MediaDeviceSource} adapter for a host. */
export function createMediaDeviceSource(host: PlatformHost = detectHost()): MediaDeviceSource {
    return host === 'tauri' ? new TauriMediaDeviceSource() : new WebMediaDeviceSource();
}
