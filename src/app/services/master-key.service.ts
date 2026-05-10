import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { EncryptedMasterKey } from '../dtos/response/UserDto';

@Injectable({ providedIn: 'root' })
export class MasterKeyService {
  async setupMasterKey(password: string, userEntropy: number[] = []): Promise<EncryptedMasterKey> {
    return invoke<EncryptedMasterKey>('setup_master_key', { password, userEntropy });
  }

  async decryptMasterKey(encrypted: EncryptedMasterKey, password: string): Promise<Uint8Array> {
    const bytes = await invoke<number[]>('decrypt_master_key', { encrypted, password });
    return new Uint8Array(bytes);
  }
}
