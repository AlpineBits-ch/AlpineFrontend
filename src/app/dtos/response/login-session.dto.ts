import {DeviceType} from './user-device.dto';

/**
 * One signed-in device, as created by any login (password, Steam or QR).
 *
 * Distinct from `UserDeviceDto`, which is an MLS crypto identity -a session is an
 * auth-token lifetime, and revoking one does not touch the device's message keys.
 */
export interface LoginSessionDto {
    id: string;
    deviceName: string;
    deviceType: DeviceType;
    ipAddress: string | null;
    createdAt: string;
    lastUsedAt: string;
    /** True for the session whose access token made this request. */
    isCurrent: boolean;
    /**
     * The registered device this login came from; null for logins that sent none.
     *
     * This is what finally relates a session to a machine: `isCurrent` only identifies the token
     * that made the request, so before this the sessions and devices lists were unrelatable.
     */
    clientDeviceId: string | null;
}
