/**
 * Status of a QR pairing code, polled by the device that is trying to sign in.
 *
 * `denied` is terminal in the same way an expired code is: the server will not let a
 * rejected code be approved afterwards, so the only recovery is starting a new pairing.
 */
export type QrLoginStatus = 'pending' | 'scanned' | 'approved' | 'denied';

export interface QrLoginStartResponse {
    /** Opaque pairing code. Rendered verbatim as the QR payload -no URI scheme wrapper. */
    code: string;
    expiresInSeconds: number;
}

export interface QrLoginStatusResponse {
    /**
     * Serialized PascalCase on the wire (`"Approved"`) even though the API guide documents
     * it lowercase, so this is deliberately untyped -run it through `QrLoginService.status`,
     * which normalises the casing, rather than comparing it against `QrLoginStatus` directly.
     */
    status: string;
}
