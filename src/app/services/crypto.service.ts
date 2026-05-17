import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';

export interface KeyPairEntry {
    keyId: string;
    publicKey: string;  // Base64-encoded SPKI
    privateKey: string; // Base64-encoded PKCS8
}

const RSA_OAEP_PARAMS = {name: 'RSA-OAEP', hash: 'SHA-256'} as const;

@Injectable({providedIn: 'root'})
export class CryptoService {
    private readonly keyStore = new Map<string, CryptoKeyPair>();

    async generateKeyPairs(count: number): Promise<KeyPairEntry[]> {
        const entries = await invoke<KeyPairEntry[]>('generate_key_pairs', {count});

        // Import each key into Web Crypto so decrypt() can use them
        await Promise.all(entries.map(async entry => {
            const [publicKey, privateKey] = await Promise.all([
                crypto.subtle.importKey('spki', this.fromBase64(entry.publicKey), RSA_OAEP_PARAMS, false, ['encrypt']),
                crypto.subtle.importKey('pkcs8', this.fromBase64(entry.privateKey), RSA_OAEP_PARAMS, false, ['decrypt']),
            ]);
            this.keyStore.set(entry.keyId, {publicKey, privateKey});
        }));

        return entries;
    }

    async encrypt(plaintext: string, publicKeyBase64: string): Promise<string> {
        const pubKey = await crypto.subtle.importKey(
            'spki',
            this.fromBase64(publicKeyBase64),
            {name: 'RSA-OAEP', hash: 'SHA-256'},
            false,
            ['encrypt']
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
            this.fromBase64(ciphertextBase64)
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
