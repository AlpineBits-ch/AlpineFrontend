import {MessageDto} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {MlsService} from '../services/mls.service';
import {MlsSyncService} from '../services/mls-sync.service';
import {MlsHealthService} from '../services/mls-health.service';
import {fromBase64} from './base64.helper';

/**
 * Turns stored ciphertext back into readable content where it can. MLS decrypts from the wire
 * exactly once, so history reads from the plaintext cache or sets `undecryptable`.
 */
export async function decryptMessages(
    messages: MessageDto[],
    mlsService: MlsService,
    mlsSync: MlsSyncService,
    health: MlsHealthService,
): Promise<MessageDto[]> {
    const result: MessageDto[] = [];
    for (const msg of messages) {
        const contextId = msg.conversationId ?? msg.channelId;
        if (!contextId) {
            result.push(msg);
            continue;
        }

        const isChannel = !!msg.channelId;

        if (msg.encryptionState !== MessageEncryptionState.Encrypted) {
            // Above the monotonic encryption floor, a message claiming to be cleartext is
            // untrusted, not content (§L.9). System messages carry no author-attributed body.
            if (
                msg.type !== MessageType.System &&
                (await mlsService.getEncryptionFloor(contextId)) !== null
            ) {
                health.recordFailure(
                    contextId,
                    isChannel,
                    'downgraded',
                    `message ${msg.id} claims to be unencrypted in a context this device has ` + `encrypted`,
                );
                result.push({...msg, undecryptable: true});
                continue;
            }
            result.push(msg);
            continue;
        }

        if (msg.type === MessageType.System) {
            result.push(msg);
            continue;
        }

        // The message names the era it was sealed under; never fall back to the current group.
        const generation = msg.mlsGeneration ?? (await mlsService.getKnownGeneration(contextId));

        // Must stay keyed on context, generation and author as well as the id: `msg.id` is the
        // server's to choose, and the bare id alone leaks plaintext across conversations.
        const cached = await mlsService.getCachedMessage(contextId, generation ?? null, msg.id, msg.authorId);
        if (cached) {
            result.push({...msg, content: cached});
            continue;
        }

        const groupId =
            generation === null || generation === undefined
                ? null
                : await mlsService.getGroupId(contextId, generation);

        if (!groupId) {
            // Distinct from a decrypt failure: this device was never admitted to this era.
            health.recordFailure(contextId, isChannel, 'not-admitted');
            result.push({...msg, undecryptable: true});
            continue;
        }

        // Must go through the sync service, not the engine: it serialises against two-phase
        // commits for the same group and carries the roster check.
        const plaintext = await mlsSync.decryptMessage(
            contextId,
            isChannel,
            groupId,
            fromBase64(msg.content),
            msg.id,
            msg.authorId,
        );

        if (plaintext) {
            void mlsService.cacheMessage(contextId, generation ?? null, msg.id, plaintext, msg.authorId);
            result.push({...msg, content: plaintext});
            continue;
        }

        // Ordinary when paging past the ratchet's reach, and permanent when it happens.
        result.push({...msg, undecryptable: true});
    }
    return result;
}
