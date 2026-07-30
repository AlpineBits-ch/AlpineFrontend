import {DeviceType} from '../response/user-device.dto';

export interface StartQrLoginDto {
    /** Human-readable label shown to the approving phone and later in the sessions list. */
    deviceName: string;
    deviceType: DeviceType;
}
