import { Injectable } from '@angular/core';

export interface KeyPairEntry {
  keyId: string;
  publicKey: string;  // Base64-encoded SPKI
  privateKey: string; // Base64-encoded PKCS8
}

@Injectable({ providedIn: 'root' })
export class CryptoService {
  private readonly keyStore = new Map<string, CryptoKeyPair>();

  async generateKeyPairs(count: number): Promise<KeyPairEntry[]> {
    const results: KeyPairEntry[] = [];

    for (let i = 0; i < count; i++) {
      const pair = await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['encrypt', 'decrypt']
      );

      const keyId = crypto.randomUUID();
      this.keyStore.set(keyId, pair);

      const [pubRaw, privRaw] = await Promise.all([
        crypto.subtle.exportKey('spki', pair.publicKey),
        crypto.subtle.exportKey('pkcs8', pair.privateKey),
      ]);

      results.push({
        keyId,
        publicKey: this.toBase64(pubRaw),
        privateKey: this.toBase64(privRaw),
      });
    }

    return results;
  }

  async encrypt(plaintext: string, publicKeyBase64: string): Promise<string> {
    const pubKey = await crypto.subtle.importKey(
      'spki',
      this.fromBase64(publicKeyBase64),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );

    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, encoded);
    return this.toBase64(cipherBuf);
  }

  async decrypt(ciphertextBase64: string, keyId: string): Promise<string> {
    const pair = this.keyStore.get(keyId);
    if (!pair) throw new Error(`No key found for id: ${keyId}`);

    const plainBuf = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
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
