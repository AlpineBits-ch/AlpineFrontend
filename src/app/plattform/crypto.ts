import {invoke} from '@tauri-apps/api/core'

export const getSecureKey = async (): Promise<Uint8Array> => {

    const bytes = await invoke<number[]>('generate_key');

  
    return new Uint8Array(bytes);
};