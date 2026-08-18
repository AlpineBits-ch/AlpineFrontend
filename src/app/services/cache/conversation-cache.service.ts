import {inject, Injectable} from '@angular/core';

import {ConversationDto, ConversationMemberDto} from '../../dtos/response/conversation.dto';
import {CacheStore, CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';

/** The whole list lives under one key: it is read and written as a unit, never per conversation. */
export const CONVERSATION_LIST_KEY = 'list';

/** How many are kept. Matches the store's PAGE_SIZE, so a hydrate covers exactly the first page. */
const KEEP = 20;

/**
 * Keeps the first page of the DM list across restarts.
 *
 * Without it `ConversationStore.loadInitial()` is a cold round trip fired from
 * `ConversationListComponent`'s constructor, so the sidebar sits empty for as long as that takes,
 * which is after the splash has already come down.
 */
@Injectable({providedIn: 'root'})
export class ConversationCacheService {
    private readonly stores = inject(CacheStoreFactory);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    async remember(conversations: ConversationDto[]): Promise<void> {
        const keep = [...conversations]
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .slice(0, KEEP);

        if (keep.length === 0) {
            await this.forget();
            return;
        }
        await (await this.cache()).set('conversation', CONVERSATION_LIST_KEY, keep);
    }

    async recall(): Promise<ConversationDto[]> {
        const stored = await (
            await this.cache()
        ).get<ConversationDto[]>('conversation', CONVERSATION_LIST_KEY);
        return (stored ?? []).map(revive);
    }

    async forget(): Promise<void> {
        await (await this.cache()).delete('conversation', CONVERSATION_LIST_KEY);
    }

    /** Resolved on every operation, never memoised: this service outlives the account it first ran for. */
    private async cache(): Promise<CacheStore> {
        return this.stores.open(await this.deviceIdentity.deviceId());
    }
}

function revive(conversation: ConversationDto): ConversationDto {
    return {
        ...conversation,
        createdAt: new Date(conversation.createdAt),
        updatedAt: new Date(conversation.updatedAt),
        members: conversation.members.map(reviveMember),
    };
}

function reviveMember(member: ConversationMemberDto): ConversationMemberDto {
    return {
        ...member,
        createdAt: new Date(member.createdAt),
        updatedAt: new Date(member.updatedAt),
    };
}
