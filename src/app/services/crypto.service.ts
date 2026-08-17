import {inject, Injectable, Injector} from '@angular/core';
import {CryptoEngine} from '../platform/ports/crypto-engine.port';

export interface KeyPairEntry {
    keyId: string;
    publicKey: string; // Base64-encoded SPKI
    privateKey: string; // Base64-encoded PKCS8
}

const RSA_OAEP_PARAMS = {name: 'RSA-OAEP', hash: 'SHA-256'} as const;

@Injectable({providedIn: 'root'})
export class CryptoService {
    private readonly keyStore = new Map<string, CryptoKeyPair>();

    private readonly injector = inject(Injector);

    /**
     * Key generation stays in Rust on both hosts.
     *
     * <p>Not reimplemented over WebCrypto for the browser: `generate_key_pairs` mints RSA-OAEP keys in
     * the exact SPKI/PKCS8 encoding the server and every other client expect, and a second
     * implementation of that would be a second thing to keep byte-compatible. The keys are imported
     * into WebCrypto below on both hosts anyway, which is the half that has to be a browser API.</p>
     *
     * <p>Resolved on demand rather than as a field, like the other two services on this port: only
     * {@link generateKeyPairs} needs it, while {@link encrypt} and {@link decrypt} are pure WebCrypto -
     * so a consumer that only ever decrypts should not need a `CryptoEngine` provider to exist.</p>
     */
    private get engine(): CryptoEngine {
        return this.injector.get(CryptoEngine);
    }

    async generateKeyPairs(count: number): Promise<KeyPairEntry[]> {
        const entries = await this.engine.call<KeyPairEntry[]>('generate_key_pairs', {count});

        // Import each key into Web Crypto so decrypt() can use them
        await Promise.all(
            entries.map(async entry => {
                const [publicKey, privateKey] = await Promise.all([
                    crypto.subtle.importKey(
                        'spki',
                        this.fromBase64(entry.publicKey),
                        RSA_OAEP_PARAMS,
                        false,
                        ['encrypt'],
                    ),
                    crypto.subtle.importKey(
                        'pkcs8',
                        this.fromBase64(entry.privateKey),
                        RSA_OAEP_PARAMS,
                        false,
                        ['decrypt'],
                    ),
                ]);
                this.keyStore.set(entry.keyId, {publicKey, privateKey});
            }),
        );

        return entries;
    }

    async encrypt(plaintext: string, publicKeyBase64: string): Promise<string> {
        const pubKey = await crypto.subtle.importKey(
            'spki',
            this.fromBase64(publicKeyBase64),
            {name: 'RSA-OAEP', hash: 'SHA-256'},
            false,
            ['encrypt'],
        );

        const encoded = new TextEncoder().encode(plaintext);
        const cipherBuf = await crypto.subtle.encrypt({name: 'RSA-OAEP'}, pubKey, encoded);
        return this.toBase64(cipherBuf);
    }

    async decrypt(ciphertextBase64: string, keyId: string): Promise<string> {
        const pair = this.keyStore.get(keyId);
        if (!pair) throw new Error(`No key found for id: ${keyId}`);

        const plainBuf = await crypto.subtle.decrypt(
            {name: 'RSA-OAEP'},
            pair.privateKey,
            this.fromBase64(ciphertextBase64),
        );

        return new TextDecoder().decode(plainBuf);
    }

    private toBase64(buf: ArrayBuffer): string {
        return btoa(String.fromCharCode(...new Uint8Array(buf)));
    }

    private fromBase64(b64: string): ArrayBuffer {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
    }
}
