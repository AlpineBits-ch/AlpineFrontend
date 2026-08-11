import {MediaDeviceEntry, MediaDeviceSource} from '../ports/media-devices.port';
import {
    fullOutputSupport,
    onDeviceChange,
    OutputSupport,
    OutputSupportReporting,
} from '../media-device-support';

/**
 * What `enumerate_audio_devices` and `enumerate_output_devices` return.
 *
 * <p>`isDefault` is optional because it is optional in practice: it arrives camelCased from serde on
 * the two audio commands and is absent from the camera one. Reading a missing flag as "not the
 * default" is safe; inventing one is not.</p>
 */
interface RustAudioDevice {
    id: string;
    name: string;
    isDefault?: boolean;
}

/** What `enumerate_camera_devices` returns. No default is reported, so none is claimed. */
interface RustCameraDevice {
    id: string;
    name: string;
}

/**
 * The desktop device catalog: cpal for audio, nokhwa for cameras, through three Tauri commands.
 *
 * <p><b>`id` is a platform device *name*, not a web device id</b>, because that is what the Rust
 * capture pipeline looks devices up by - see the note on {@link MediaDeviceEntry} and
 * `MediaDeviceResolverService`, which translates one into the other for anything that has to reach a
 * Web API.</p>
 *
 * <p>The Rust side already prepends a synthetic `{id: 'default', name: 'Default', isDefault: true}`
 * entry to both audio lists. This adapter passes it through untouched and adds nothing of its own; a
 * second "Default" row in a picker is how these lists start looking untrustworthy.</p>
 *
 * <p>`@tauri-apps/api/core` is imported on first call rather than at module load, so the web bundle
 * never pulls it even if this module is reached.</p>
 */
export class TauriMediaDeviceSource extends MediaDeviceSource implements OutputSupportReporting {
    inputs(): Promise<MediaDeviceEntry[]> {
        return this.audioDevices('enumerate_audio_devices');
    }

    outputs(): Promise<MediaDeviceEntry[]> {
        return this.audioDevices('enumerate_output_devices');
    }

    async cameras(): Promise<MediaDeviceEntry[]> {
        const cameras = await this.command<RustCameraDevice[]>('enumerate_camera_devices');
        return cameras.map(camera => ({id: camera.id, label: camera.name, isDefault: false}));
    }

    onChange(handler: () => void): () => void {
        return onDeviceChange(handler);
    }

    /**
     * Full support, and not by feature detection.
     *
     * <p>Desktop playback goes through the Rust voice engine, which takes an `outputDeviceId` and
     * opens that cpal device itself (`voice-engine.service.ts` passes it; `src-tauri`'s playout
     * consumes it). So output selection here does not depend on `setSinkId` existing in the webview,
     * and probing for it would gate a control that demonstrably works.</p>
     */
    async outputSupport(): Promise<OutputSupport> {
        return fullOutputSupport();
    }

    private async audioDevices(command: string): Promise<MediaDeviceEntry[]> {
        const devices = await this.command<RustAudioDevice[]>(command);
        return devices.map(device => ({
            id: device.id,
            label: device.name,
            isDefault: device.isDefault === true,
        }));
    }

    private async command<T>(name: string): Promise<T> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<T>(name);
    }
}
