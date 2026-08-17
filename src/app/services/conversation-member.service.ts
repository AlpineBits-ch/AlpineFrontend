import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {ConversationService} from './conversation.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {ConversationDto} from '../dtos/response/conversation.dto';
import {UnreachableDeviceDto} from '../dtos/mls.dto';

export interface AddConversationMemberResult {
    conversation: ConversationDto;
    /**
     * Devices that had no key package left, so they were not admitted to the group. Their owner is
     * in the conversation but cannot read it until they next come online and are added.
     */
    unreachableDevices: UnreachableDeviceDto[];
}

/**
 * Adding someone to a group conversation.
 *
 * <p>Two steps that must happen in this order. The roster comes first: a member who cannot yet read
 * sees an empty conversation, which is recoverable and visible. The reverse - holding group keys
 * without being a member - would leave them able to decrypt traffic for a conversation the server
 * does not believe they are in.</p>
 */
@Injectable({providedIn: 'root'})
export class ConversationMemberService {
    private conversations = inject(ConversationService);
    private mls = inject(MlsService);
    private sync = inject(MlsSyncService);

    async addMember(conversationId: string, userId: string): Promise<AddConversationMemberResult> {
        const conversation = await firstValueFrom(this.conversations.addMember(conversationId, userId));

        // Plaintext conversation: membership is the whole of it.
        const generation = await this.mls.getKnownGeneration(conversationId);
        if (generation === null) {
            return {conversation, unreachableDevices: []};
        }

        const unreachableDevices = await this.sync.addMembers(conversationId, false, [userId]);
        return {conversation, unreachableDevices};
    }
}
