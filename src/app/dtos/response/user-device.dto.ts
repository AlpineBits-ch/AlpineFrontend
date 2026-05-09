export enum DeviceType {
  Desktop = 'Desktop',
  Mobile  = 'Mobile',
  Web     = 'Web',
}

export enum DeviceStatus {
  Active  = 'Active',
  Revoked = 'Revoked',
}

export interface UserDeviceDto {
  id: string;
  userId: string;
  deviceName: string;
  deviceType: DeviceType;
  /** Base64-encoded Ed25519 MLS identity public key */
  identityPublicKey: string;
  status: DeviceStatus;
  lastSeen: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
