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

/**
 * The metadata of the most recent page of each context, so a reopened conversation has something
 * to draw before the network answers.
 *
 * <h3>Bodies are not stored here, except when nothing else stores them</h3>
 *
 * <p>An encrypted message's plaintext is already in `MlsService`'s cache: sealed, keyed by context
 * and generation, and carried in the §D backup envelope. Writing it here as well would put a second
 * copy of every plaintext at rest and drag the envelope into this design, so the body is dropped
 * and `decryptMessages` refills it from the existing cache on the way back in.</p>
 *
 * <p>An <b>unencrypted</b> message has no such second home - drop its body and the cached copy is a
 * blank message. Those keep their content. It is stored in the clear on the server anyway, so a
 * sealed local copy is strictly better protected than the original.</p>
 */
@Injectable({providedIn: 'root'})
export class MessageCacheService {
    private readonly stores = inject(CacheStoreFactory);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private store: CacheStore | undefined;

    async remember(contextKey: string, messages: MessageDto[]): Promise<void> {
        const keep = messages
            // An optimistic message that never reached the server would come back from disk as a
            // real one after a restart, indistinguishable from a sent message.
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

    private async cache(): Promise<CacheStore> {
        this.store ??= this.stores.open(await this.deviceIdentity.deviceId());
        return this.store;
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
