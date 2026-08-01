export enum DeviceType {
    Desktop = 'Desktop',
    Mobile = 'Mobile',
    Web = 'Web',
}

export enum DeviceStatus {
    Active = 'Active',
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
    /**
     * Set on a registration response when the submitted identity key differed from the stored one,
     * so the server replaced it and purged this device's key packages.
     *
     * The client must re-upload. The purged packages were minted under a signing key that no longer
     * exists, and any Welcome sealed to one of them would be undecryptable by the very device it
     * was addressed to.
     */
    identityRotated?: boolean;
}
