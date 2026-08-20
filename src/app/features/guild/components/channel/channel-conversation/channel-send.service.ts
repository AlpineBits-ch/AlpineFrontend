import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, EMPTY, firstValueFrom, from, tap} from 'rxjs';

import {ChannelDto} from '../../../../../dtos/response/guild.dto';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';
import {MessageType} from '../../../../../enums/message-type.enum';
import {toBase64} from '../../../../../helpers/base64.helper';
import {MessagingService} from '../../../../../services/messaging.service';
import {MlsService} from '../../../../../services/mls.service';
import {MlsSyncService} from '../../../../../services/mls-sync.service';
import {PersonaService} from '../../../../../services/persona.service';
import {ProfileService} from '../../../../../services/profile.service';
import {SceneService} from '../../../../../services/scene.service';
import {MessageStore} from '../../../../../stores/message.store';
import {personaIdentity} from '../../../personas/persona-identity';
import {classifyAutoModError, mayPostCleartext} from '../channel-utils';
import {ChannelEncryptionService} from './channel-encryption.service';

/** What the composer hands over: the body plus everything typed alongside it. */
export interface ChannelMessageDraft {
    content: string;
    attachments: string[];
    inReplyTo?: string;
    mentions: string[];
    roleMentions: string[];
    /** Persona ids named in the body as `<@pers_...>`. */
    personaMentions: string[];
    mentionsEveryone: boolean;
    mentionsHere: boolean;
    personaId?: string;
}

/** The fields that travel to the server unchanged from the draft. `inReplyTo` is required there, undefined and all. */
type DraftFields = Omit<ChannelMessageDraft, 'content' | 'inReplyTo'> & {inReplyTo: string | undefined};

/**
 * Posts to a channel, encrypting where the channel is encrypted, and drives the optimistic message
 * from Enter to confirmation. Component-scoped, alongside {@link ChannelEncryptionService}.
 */
@Injectable()
export class ChannelSendService {
    /** Set when the server refuses a send via auto-mod, cleared on the next attempt. */
    readonly autoModError = signal<'blocked_word' | 'rate_limited' | null>(null);

    private readonly encryption = inject(ChannelEncryptionService);
    private readonly messageStore = inject(MessageStore);
    private readonly messagingService = inject(MessagingService);
    private readonly mls = inject(MlsService);
    private readonly mlsSync = inject(MlsSyncService);
    private readonly personaService = inject(PersonaService);
    private readonly profileService = inject(ProfileService);
    private readonly scenes = inject(SceneService);

    submit(channel: ChannelDto, draft: ChannelMessageDraft): void {
        const {content, ...fields} = draft;
        const rest: DraftFields = {...fields, inReplyTo: draft.inReplyTo};
        const tempId = crypto.randomUUID();
        const now = new Date();
        const channelId = channel.id;
        const b64Content = toBase64(content);

        this.autoModError.set(null);

        const speaking = this.personaService.entry(channel.guildId, draft.personaId);
        const optimisticIdentity = speaking ? personaIdentity(speaking) : null;

        const optimistic: MessageDto = {
            id: tempId,
            content: b64Content,
            channelId,
            conversationId: undefined,
            authorId: this.profileService.ownProfile()?.userId ?? '',
            createdAt: now,
            updatedAt: now,
            isPending: true,
            isFailed: false,
            attachments: [],
            inReplyTo: draft.inReplyTo,
            mentions: draft.mentions,
            roleMentions: draft.roleMentions,
            mentionsEveryone: draft.mentionsEveryone,
            mentionsHere: draft.mentionsHere,
            encryptionState: MessageEncryptionState.Plain,
            mlsEpoch: undefined,
            mlsSequenceNumber: undefined,
            senderDeviceId: undefined,
            type: MessageType.Message,
            personaId: draft.personaId,
            // The server sends its own copy back; this only keeps the character on screen in the
            // moment between Enter and the confirmation.
            authorDisplayName: optimisticIdentity?.name ?? null,
            authorAvatarUrl: optimisticIdentity?.avatarUrl ?? null,
        };

        this.messageStore.addMessage(optimistic);
        // The turn advances server-side when the character posts, and no event says so; this keeps
        // the rail honest in the meantime. See SceneService.notePost.
        this.scenes.notePost(channel.guildId, channelId, draft.personaId ?? null);

        from(this.post(channelId, content, b64Content, rest))
            .pipe(
                tap(({confirmed, generation}) => {
                    // Encrypted send returns ciphertext; MLS ratchets forward only, so this is the one moment the plaintext can still be cached.
                    if (confirmed.encryptionState === MessageEncryptionState.Encrypted) {
                        // Keyed on the generation this device sealed with, not the server's id: keying on the server's choice alone would let it replay one context's plaintext into another.
                        void this.mls.cacheMessage(
                            channelId,
                            generation,
                            confirmed.id,
                            b64Content,
                            this.profileService.ownProfile()?.userId,
                        );
                        const shown = {...confirmed, content: b64Content};
                        this.messageStore.confirmMessage(tempId, shown);
                        this.messagingService.messageSentObservable.next(shown);
                        return;
                    }
                    this.messageStore.confirmMessage(tempId, confirmed);
                    this.messagingService.messageSentObservable.next(confirmed);
                }),
                catchError((err: HttpErrorResponse) => {
                    this.messageStore.failMessage(tempId);
                    const autoModReason = classifyAutoModError(err);
                    if (autoModReason) {
                        this.autoModError.set(autoModReason);
                        this.messageStore.removeMessage(tempId);
                    }
                    return EMPTY;
                }),
            )
            .subscribe();
    }

    /** Posts to the channel, encrypting when the channel is encrypted; a 409 means the client's encryption state is stale (channel encryption toggled), so it re-reads and sends once more. */
    private async post(
        channelId: string,
        content: string,
        b64Content: string,
        rest: DraftFields,
    ): Promise<{confirmed: MessageDto; generation: number | null}> {
        try {
            return await this.attempt(channelId, content, b64Content, rest);
        } catch (err) {
            if (!(err instanceof HttpErrorResponse) || err.status !== 409) throw err;
            // Catches both directions: plaintext into a channel that was just encrypted, and ciphertext into one that was just turned back to plaintext.
            await this.mlsSync.refreshState(channelId, true);
            return this.attempt(channelId, content, b64Content, rest);
        }
    }

    // The generation travels back out with the confirmation: the plaintext cache is keyed on it, since this device is the only trustworthy source for which generation sealed the message.
    private async attempt(
        channelId: string,
        content: string,
        b64Content: string,
        rest: DraftFields,
    ): Promise<{confirmed: MessageDto; generation: number | null}> {
        const generation = await this.mls.getKnownGeneration(channelId);
        const floor = await this.mls.getEncryptionFloor(channelId);

        if (generation === null) {
            // Refused here rather than by the server: the server's rejection only arrives after the plaintext has already left this machine, which can't be undone. See `mayPostCleartext` for why the three conditions differ.
            if (!mayPostCleartext(generation, this.encryption.state(), floor)) {
                throw new Error(`Channel ${channelId} is encrypted and this device holds no group for it`);
            }

            const confirmed = await firstValueFrom(
                this.messagingService.createMessage({
                    content,
                    channelId,
                    conversationId: undefined,
                    ...rest,
                }),
            );
            return {confirmed, generation: null};
        }

        const keyHandle = this.mls.keyHandle();
        const groupId = await this.mls.getGroupId(channelId, generation);
        if (!keyHandle || !groupId) {
            throw new Error(`No MLS group held for encrypted channel ${channelId}`);
        }

        const {ciphertext, epoch} = await firstValueFrom(
            this.mls.sendMessage(groupId, keyHandle, b64Content),
        );

        const confirmed = await firstValueFrom(
            this.messagingService.createMessage({
                content: ciphertext,
                channelId,
                conversationId: undefined,
                ...rest,
                encryptionState: MessageEncryptionState.Encrypted,
                mlsEpoch: epoch,
                mlsGeneration: generation,
                senderDeviceId: await this.mls.getOrCreateDeviceIdentifier(),
            }),
        );
        return {confirmed, generation};
    }
}
