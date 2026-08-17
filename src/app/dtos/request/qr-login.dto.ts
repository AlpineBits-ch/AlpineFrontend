import {DeviceType} from '../response/user-device.dto';

export interface StartQrLoginDto {
    /** Human-readable label shown to the approving phone and later in the sessions list. */
    deviceName: string;
    deviceType: DeviceType;
    /** Carried through the pairing and attached to the session minted at /connect/token. */
    clientDeviceId?: string;
}
