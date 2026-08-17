import {inject, Injectable} from '@angular/core';

import {MessageDto} from '../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';
import {CacheStore, CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';

/** The most recent page kept per context. Matches the store's PAGE_SIZE. */
const KEEP_PER_CONTEXT = 30;

/** Distinct keys for a conversation and a channel that happen to share an id. */
export function messageContextKey(opts: {conversationId?: string; channelId?: string}): string {
    return opts.conversationId ? `conv:${opts.conversationId}` : `chan:${opts.channelId}`;
}

/** The most recent page of each context's metadata. Encrypted bodies are dropped; unencrypted ones are kept. */
@Injectable({providedIn: 'root'})
export class MessageCacheService {
    private readonly stores = inject(CacheStoreFactory);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    async remember(contextKey: string, messages: MessageDto[]): Promise<void> {
        const keep = messages
            // An optimistic message would come back from disk as a real one after a restart.
            .filter(m => !m.isPending && !m.isFailed)
            .slice(0, KEEP_PER_CONTEXT)
            .map(strip);

        if (keep.length === 0) {
            await this.forget(contextKey);
            return;
        }
        await (await this.cache()).set('message', contextKey, keep);
    }

    async recall(contextKey: string): Promise<MessageDto[]> {
        const stored = await (await this.cache()).get<MessageDto[]>('message', contextKey);
        return (stored ?? []).map(revive);
    }

    async forget(contextKey: string): Promise<void> {
        await (await this.cache()).delete('message', contextKey);
    }

    /** Resolved on every operation, never memoised: this service outlives the account it first ran for. */
    private async cache(): Promise<CacheStore> {
        return this.stores.open(await this.deviceIdentity.deviceId());
    }
}

function strip(message: MessageDto): MessageDto {
    if (message.encryptionState !== MessageEncryptionState.Encrypted) return message;
    return {...message, content: ''};
}

function revive(message: MessageDto): MessageDto {
    return {
        ...message,
        createdAt: new Date(message.createdAt),
        updatedAt: new Date(message.updatedAt),
    };
}
