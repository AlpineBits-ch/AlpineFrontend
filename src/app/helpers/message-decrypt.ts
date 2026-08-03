import {MessageDto} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {MlsService} from '../services/mls.service';
import {MlsSyncService} from '../services/mls-sync.service';
import {MlsHealthService} from '../services/mls-health.service';
import {fromBase64} from './base64.helper';

/**
 * Turns stored ciphertext back into readable content where it can.
 *
 * The plaintext cache is not an optimisation, it is the only way most of this succeeds. MLS ratchets
 * forward and never backward, so a message can be decrypted from the wire exactly once, on the
 * device that was in the group at the time. Paging back through history therefore reads from the
 * cache or not at all - `undecryptable` is set so the UI can say so plainly instead of rendering
 * base64 at the user.
 *
 * <p>Lifted out of `MessageStore` when the inbox needed it. The inbox serves message previews for
 * every guild at once, including encrypted channels, and the server cannot decrypt those - so its
 * previews have to travel the same path history does, or they are base64 at the reader. Every rule
 * below is one the inbox needs as much as the store: the encryption floor, the author re-check on
 * a cache hit, the honest failure when this device was never admitted.</p>
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
            // `encryptionState` is a per-message server field, and skipping the decryptor on it
            // rendered `content` verbatim under `authorId` - arbitrary text in an end-to-end
            // encrypted thread, attributed to a real member, needing no group keys at all. §L.9
            // forbids exactly this, and `applyRemoteUpdate` already got it right by deciding from
            // the *stored* state. The equivalent local fact on the read paths is the monotonic
            // encryption floor: above it, a message claiming to be cleartext is untrusted, not
            // content.
            //
            // System messages are exempt because they carry no author-attributed body - they are
            // rendered from `type` and a variant index, not from `content`.
            if (msg.type !== MessageType.System
                && await mlsService.getEncryptionFloor(contextId) !== null) {
                health.recordFailure(
                    contextId, isChannel, 'downgraded',
                    `message ${msg.id} claims to be unencrypted in a context this device has `
                    + `encrypted`);
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

        // The message names the era it was sealed under. Falling back to whichever group we
        // currently hold would decrypt against the wrong keys once a context has been toggled off
        // and on, producing silent garbage instead of an honest failure.
        const generation = msg.mlsGeneration ?? await mlsService.getKnownGeneration(contextId);

        // Keyed on context and generation as well as the id, and checked against the author the
        // server is claiming right now. `msg.id` is the server's to choose: on the bare id alone,
        // an id replayed from another conversation returned that conversation's plaintext here,
        // and on this path the lookup happens before the group is even resolved - so the reader
        // need not be a member of the context the id came from.
        const cached = await mlsService.getCachedMessage(
            contextId, generation ?? null, msg.id, msg.authorId);
        if (cached) {
            result.push({...msg, content: cached});
            continue;
        }

        const groupId = generation === null || generation === undefined
            ? null
            : await mlsService.getGroupId(contextId, generation);

        if (!groupId) {
            // Distinct from a decrypt failure: this device was never admitted to the era the
            // message belongs to, which is a state the user can act on by re-linking.
            health.recordFailure(contextId, isChannel, 'not-admitted');
            result.push({...msg, undecryptable: true});
            continue;
        }

        // Through the sync service: history paging used to call the engine directly, so a decrypt
        // could interleave between the stage and the merge of a two-phase commit for the same
        // group. It also carries the roster check, which had no call sites at all before this.
        const plaintext = await mlsSync.decryptMessage(
            contextId, isChannel, groupId, fromBase64(msg.content), msg.id, msg.authorId,
        );

        if (plaintext) {
            void mlsService.cacheMessage(
                contextId, generation ?? null, msg.id, plaintext, msg.authorId);
            result.push({...msg, content: plaintext});
            continue;
        }

        // Ordinary when paging past the ratchet's reach, and permanent when it happens: MLS
        // decrypts from the wire exactly once. `undecryptable` is what lets the UI say so rather
        // than rendering base64 at the reader.
        result.push({...msg, undecryptable: true});
    }
    return result;
}
