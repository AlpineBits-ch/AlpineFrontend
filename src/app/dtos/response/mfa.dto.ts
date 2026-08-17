export interface MfaEnrollResponse {
    /** Base32 authenticator secret, shown as selectable text for manual entry. */
    secret: string;
    /** Full `otpauth://totp/...` URI - render this as the QR code. */
    otpAuthUri: string;
}

export interface MfaRecoveryCodesResponse {
    /** Eight single-use codes. Shown exactly once; there is no "view codes" endpoint. */
    recoveryCodes: string[];
}
