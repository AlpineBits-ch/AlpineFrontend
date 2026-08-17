import {inject, Injectable} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {MessagingService} from '../../services/messaging.service';
import {MlsService} from '../../services/mls.service';
import {MlsSyncService} from '../../services/mls-sync.service';
import {ProfileService} from '../../services/profile.service';
import {MessageDto} from '../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';
import {toBase64} from '../../helpers/base64.helper';

/** Exactly one of these is set. */
export interface SendTarget {
    channelId?: string;
    conversationId?: string;
}

/**
 * Refused before anything left the machine. Thrown rather than downgraded, so a caller reports it
 * instead of quietly posting in the clear somewhere that is meant to be encrypted.
 */
export class EncryptionUnavailableError extends Error {
    constructor(contextId: string) {
        super(`This device holds no MLS group for ${contextId}, which is encrypted here`);
        this.name = 'EncryptionUnavailableError';
    }
}

/** Posts a message to a context that is not the one on screen. */
@Injectable({providedIn: 'root'})
export class MessageSendService {
    private readonly messaging = inject(MessagingService);
    private readonly mls = inject(MlsService);
    private readonly mlsSync = inject(MlsSyncService);
    private readonly profileService = inject(ProfileService);

    async sendText(target: SendTarget, text: string): Promise<MessageDto> {
        const contextId = target.channelId ?? target.conversationId;
        if (!contextId) throw new Error('A message needs a channel or a conversation');

        try {
            return await this.attempt(target, contextId, text);
        } catch (err) {
            if (!(err instanceof HttpErrorResponse) || err.status !== 409) throw err;
            // Both directions: plaintext into a context that was just encrypted, and ciphertext
            // into one that was just turned back. Re-read what is true and send once more.
            await this.mlsSync.refreshState(contextId, !!target.channelId);
            return this.attempt(target, contextId, text);
        }
    }

    private async attempt(target: SendTarget, contextId: string, text: string): Promise<MessageDto> {
        const b64Content = toBase64(text);
        const generation = await this.mls.getKnownGeneration(contextId);

        if (generation === null) {
            // The monotonic floor outranks anything the server says: a context this device has ever
            // held a group for stays encrypted here, and the right answer is to send nothing.
            if ((await this.mls.getEncryptionFloor(contextId)) !== null) {
                throw new EncryptionUnavailableError(contextId);
            }
            return firstValueFrom(
                this.messaging.createMessage({
                    content: text,
                    channelId: target.channelId,
                    conversationId: target.conversationId,
                    attachments: [],
                    inReplyTo: undefined,
                    mentions: [],
                }),
            );
        }

        const keyHandle = this.mls.keyHandle();
        const groupId = await this.mls.getGroupId(contextId, generation);
        if (!keyHandle || !groupId) throw new EncryptionUnavailableError(contextId);

        const {ciphertext, epoch} = await firstValueFrom(
            this.mls.sendMessage(groupId, keyHandle, b64Content),
        );

        const confirmed = await firstValueFrom(
            this.messaging.createMessage({
                content: ciphertext,
                channelId: target.channelId,
                conversationId: target.conversationId,
                attachments: [],
                inReplyTo: undefined,
                mentions: [],
                encryptionState: MessageEncryptionState.Encrypted,
                mlsEpoch: epoch,
                mlsGeneration: generation,
                senderDeviceId: await this.mls.getOrCreateDeviceIdentifier(),
            }),
        );

        // The one moment our own plaintext can still be kept - MLS ratchets forward only, so after
        // this the message we just sent is as unreadable to us as anybody else's. Keyed on the
        // generation this device sealed with rather than on anything the server echoed back. The
        // copy that arrives over the websocket a moment later is decrypted against this cache.
        await this.mls.cacheMessage(
            contextId,
            generation,
            confirmed.id,
            b64Content,
            this.profileService.ownProfile()?.userId,
        );
        return {...confirmed, content: b64Content};
    }
}
