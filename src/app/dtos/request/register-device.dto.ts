import { DeviceType } from '../response/user-device.dto';

export interface RegisterDeviceDto {
  /** Stable UUID persisted in local settings — used as an idempotency key. */
  clientDeviceId: string;
  deviceName: string;
  deviceType: DeviceType;
  /** Base64-encoded Ed25519 MLS identity public key */
  identityPublicKey: string;
}
