import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, of, throwError} from 'rxjs';
import {MlsSyncService} from './mls-sync.service';
import {MlsProcessedMessage, MlsReplayedMessage, MlsService} from './mls.service';
import {MlsHealthService} from './mls-health.service';
import {MlsTransportService} from './mls-transport.service';
import {DeviceIdentityService} from './device-identity.service';
import {
    AckWelcomesResultDto,
    ConsumeTokensResultDto,
    MlsCommitDto,
    MlsCommitPublishedDto,
    MlsContextStateDto,
    PendingWelcomeDto,
    PublishMlsCommitDto,
} from '../dtos/mls.dto';

const DEVICE_ID = 'device-a';
const CONTEXT = 'conv-1';
const GROUP = 'Z3JvdXA=';

/**
 * Stands in for the Rust MLS layer plus its persisted registry. Group state is a plain epoch
 * counter, which is all these tests need: the point is *which* calls happen in *what* order, not
 * what OpenMLS does with the bytes (that is covered by the Rust integration tests).
 */
function makeMls() {
    const registry = new Map<string, string>();
    const activeGeneration = new Map<string, number>();
    // The monotonic high-water mark: written by `registerGroup`, and deliberately *not* removed by
    // `clearActiveGeneration`. That asymmetry is the whole of C1's fix, so the double reproduces it
    // rather than stubbing the getter to a constant.
    const encryptionFloor = new Map<string, number>();
    const epochs = new Map<string, number>();
    const calls: string[] = [];

    return {
        calls,
        registry,
        activeGeneration,
        encryptionFloor,
        epochs,

        keyHandle: () => 'handle',
        getGroupId: vi.fn(async (contextId: string, generation: number) =>
            registry.get(`${contextId}#${generation}`) ?? null),
        getKnownGeneration: vi.fn(async (contextId: string) => activeGeneration.get(contextId) ?? null),
        getActiveGroupId: vi.fn(async (contextId: string) => {
            const gen = activeGeneration.get(contextId);
            return gen === undefined ? null : registry.get(`${contextId}#${gen}`) ?? null;
        }),
        registerGroup: vi.fn(async (contextId: string, generation: number, groupId: string) => {
            registry.set(`${contextId}#${generation}`, groupId);
            activeGeneration.set(contextId, generation);
            const floor = encryptionFloor.get(contextId);
            if (floor === undefined || floor < generation) encryptionFloor.set(contextId, generation);
        }),
        clearActiveGeneration: vi.fn(async (contextId: string) => {
            activeGeneration.delete(contextId);
        }),
        getEncryptionFloor: vi.fn(async (contextId: string) =>
            encryptionFloor.get(contextId) ?? null),
        clearEncryptionFloor: vi.fn(async (contextId: string) => {
            encryptionFloor.delete(contextId);
        }),

        getGroupInfo: vi.fn((groupId: string) => of({
            groupId, epoch: epochs.get(groupId) ?? 0, ownLeafIndex: 0, members: [],
        })),
        joinGroup: vi.fn(() => {
            calls.push('joinGroup');
            return of({groupId: GROUP, epoch: 1, ownLeafIndex: 1, members: []});
        }),
        processMessage: vi.fn<(groupId: string, messageB64: string) => Observable<MlsProcessedMessage>>(
            (groupId: string) => {
                calls.push('processMessage');
                epochs.set(groupId, (epochs.get(groupId) ?? 0) + 1);
                return of({
                    kind: 'commit', plaintext: null, selfRemoved: false,
                    addedMembers: [], removedLeafIndices: [], senderIdentity: null, epoch: null,
                });
            }),
        mergePendingCommit: vi.fn((groupId: string) => {
            calls.push('mergePendingCommit');
            epochs.set(groupId, (epochs.get(groupId) ?? 0) + 1);
            return of(epochs.get(groupId)!);
        }),
        clearPendingCommit: vi.fn(() => {
            calls.push('clearPendingCommit');
            return of(undefined);
        }),
        exportGroupInfo: vi.fn(() => of('Z3JvdXBpbmZv')),
        deleteGroup: vi.fn(() => of(undefined)),
        addMembers: vi.fn(() => of({commit: 'Y29tbWl0', welcome: 'd2VsY29tZQ==', epoch: 1, groupInfo: 'ZnJlc2hpbmZv'})),
        removeMembers: vi.fn(() => of({commit: 'Y29tbWl0', welcome: null, epoch: 1, groupInfo: 'ZnJlc2hpbmZv'})),
        commitPendingProposals: vi.fn(() => of({commit: 'Y29tbWl0', welcome: null, epoch: 1, groupInfo: 'ZnJlc2hpbmZv'})),
        leaveGroup: vi.fn(() => of({commit: 'cHJvcG9zYWw=', welcome: null, epoch: 0, groupInfo: null})),
        drainPendingMessages: vi.fn<(groupId: string) => Observable<MlsReplayedMessage[]>>(() => of([])),
        getMembers: vi.fn(() => of([{leafIndex: 0, identity: 'user-2', encryptionKey: '', signatureKey: ''}])),
    };
}

function makeTransport() {
    return {
        getPendingWelcomes: vi.fn<(deviceId: string) => Observable<PendingWelcomeDto[]>>(() => of([])),
        ackWelcomes: vi.fn<(ids: string[]) => Observable<AckWelcomesResultDto>>(() => of({acknowledged: 0})),
        getCommits: vi.fn<(...args: unknown[]) => Observable<MlsCommitDto[]>>(() => of([])),
        publishCommit: vi.fn<(contextId: string, isChannel: boolean, dto: PublishMlsCommitDto) => Observable<MlsCommitPublishedDto>>(
            () => of({contextId: CONTEXT, generation: 1, epoch: 1}),
        ),
        getState: vi.fn<(...args: unknown[]) => Observable<MlsContextStateDto>>(
            () => of({contextId: CONTEXT, encrypted: true, activeGeneration: 1, epoch: 0, generations: []}),
        ),
        consumeTokensForUsers: vi.fn<(userIds: string[]) => Observable<ConsumeTokensResultDto>>(
            () => of({deviceTokens: [], unreachableDevices: []}),
        ),
        enableChannelEncryption: vi.fn(),
        disableChannelEncryption: vi.fn(),
    };
}

function setup() {
    const mls = makeMls();
    const transport = makeTransport();

    TestBed.configureTestingModule({
        providers: [
            MlsSyncService,
            {provide: MlsService, useValue: mls},
            {provide: MlsTransportService, useValue: transport},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => DEVICE_ID}},
            MlsHealthService,
        ],
    });

    return {sync: TestBed.inject(MlsSyncService), mls, transport, health: TestBed.inject(MlsHealthService)};
}

function welcome(overrides: Partial<PendingWelcomeDto> = {}): PendingWelcomeDto {
    return {
        id: 'pewe_1',
        contextId: CONTEXT,
        conversationId: CONTEXT,
        userId: 'user-1',
        deviceId: DEVICE_ID,
        welcome: 'd2VsY29tZQ==',
        generation: 1,
        epoch: 1,
        ...overrides,
    };
}

function commit(epoch: number, generation = 1): MlsCommitDto {
    return {
        id: `mlsc_${epoch}`,
        contextId: CONTEXT,
        conversationId: CONTEXT,
        generation,
        epoch,
        commit: `Y29tbWl0${epoch}`,
        senderUserId: 'user-2',
        senderDeviceId: 'device-b',
        createdAt: '2026-07-31T12:00:00Z',
    };
}

describe('MlsSyncService', () => {
    describe('welcomes', () => {
        it('acknowledges only after the join succeeded', async () => {
            const {sync, mls, transport} = setup();
            transport.getPendingWelcomes.mockReturnValue(of([welcome()]));

            await sync.processPendingWelcomes();

            expect(mls.joinGroup).toHaveBeenCalled();
            expect(transport.ackWelcomes).toHaveBeenCalledWith(['pewe_1'], DEVICE_ID);
        });

        it('leaves a failed join unacknowledged so it can be retried', async () => {
            const {sync, mls, transport} = setup();
            transport.getPendingWelcomes.mockReturnValue(of([welcome()]));
            mls.joinGroup.mockReturnValue(throwError(() => new Error('bad welcome')));

            await sync.processPendingWelcomes();

            // Acknowledging a failed join would consume the single-use init key and lock this
            // device out of the context permanently.
            expect(transport.ackWelcomes).not.toHaveBeenCalled();
        });

        it('acknowledges the good ones even when a sibling fails', async () => {
            const {sync, mls, transport} = setup();
            transport.getPendingWelcomes.mockReturnValue(of([
                welcome({id: 'pewe_bad', contextId: 'conv-bad'}),
                welcome({id: 'pewe_good', contextId: 'conv-good'}),
            ]));
            mls.joinGroup
                .mockReturnValueOnce(throwError(() => new Error('bad welcome')))
                .mockReturnValueOnce(of({groupId: GROUP, epoch: 1, ownLeafIndex: 1, members: []}));

            await sync.processPendingWelcomes();

            expect(transport.ackWelcomes).toHaveBeenCalledWith(['pewe_good'], DEVICE_ID);
        });

        it('acknowledges a generation it already joined instead of re-joining forever', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            transport.getPendingWelcomes.mockReturnValue(of([welcome()]));

            await sync.processPendingWelcomes();

            // A previous run joined but died before acking. Re-joining would fail every time.
            expect(mls.joinGroup).not.toHaveBeenCalled();
            expect(transport.ackWelcomes).toHaveBeenCalledWith(['pewe_1'], DEVICE_ID);
        });

        it('does nothing while the session is locked', async () => {
            const {sync, mls, transport} = setup();
            mls.keyHandle = () => undefined as unknown as string;

            await sync.processPendingWelcomes();

            expect(transport.getPendingWelcomes).not.toHaveBeenCalled();
        });
    });

    describe('catch-up', () => {
        it('applies commits in epoch order', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getCommits
                .mockReturnValueOnce(of([commit(1), commit(2), commit(3)]))
                .mockReturnValue(of([]));

            await sync.syncContext(CONTEXT, false);

            const applied = mls.processMessage.mock.calls.map(c => c[1]);
            expect(applied).toEqual(['Y29tbWl01', 'Y29tbWl02', 'Y29tbWl03']);
        });

        it('stops at a gap rather than applying out of order', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            // Epoch 2 is missing. Applying 3 on top of 1 forks this device permanently.
            transport.getCommits.mockReturnValue(of([commit(1), commit(3)]));

            await sync.syncContext(CONTEXT, false);

            expect(mls.processMessage).toHaveBeenCalledTimes(1);
        });

        it('pages until the server has nothing left', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getCommits
                .mockReturnValueOnce(of([commit(1)]))
                .mockReturnValueOnce(of([commit(2)]))
                .mockReturnValue(of([]));

            await sync.syncContext(CONTEXT, false);

            expect(mls.processMessage).toHaveBeenCalledTimes(2);
        });

        it('asks only for its own generation', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#3`, GROUP);
            mls.activeGeneration.set(CONTEXT, 3);

            await sync.syncContext(CONTEXT, false);

            expect(transport.getCommits).toHaveBeenCalledWith(CONTEXT, false, 0, 3);
        });

        it('does nothing for a context it holds no group for', async () => {
            const {sync, transport} = setup();

            await sync.syncContext('unknown', false);

            expect(transport.getCommits).not.toHaveBeenCalled();
        });

        it('commits a departing member\'s proposal rather than leaving it hanging', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getCommits
                .mockReturnValueOnce(of([commit(1)]))
                .mockReturnValue(of([]));
            mls.processMessage.mockReturnValue(of({
                kind: 'proposal', plaintext: null, selfRemoved: false,
                addedMembers: [], removedLeafIndices: [], senderIdentity: null, epoch: null,
            }));

            await sync.syncContext(CONTEXT, false);

            // MLS does not let anyone commit their own removal. Until a remaining member turns the
            // proposal into a commit, the group keeps encrypting to someone who has already thrown
            // their keys away.
            expect(mls.commitPendingProposals).toHaveBeenCalled();
        });

        it('does not re-commit a proposal on the next sync', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getCommits
                .mockReturnValueOnce(of([commit(1)]))
                .mockReturnValue(of([]));
            mls.processMessage.mockReturnValue(of({
                kind: 'proposal', plaintext: null, selfRemoved: false,
                addedMembers: [], removedLeafIndices: [], senderIdentity: null, epoch: null,
            }));

            await sync.syncContext(CONTEXT, false);
            await sync.syncContext(CONTEXT, false);

            expect(mls.commitPendingProposals).toHaveBeenCalledTimes(1);
        });

        it('terminates when the server keeps returning a proposal that consumed no epoch', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);

            // What the real server does - and what the old `[]`-on-the-second-call mock hid.
            // Processing a proposal advances nobody's MLS epoch, so the same row comes back from
            // the same `sinceEpoch` forever. Counting it as progress meant the loop never
            // terminated and issued an unbounded stream of requests.
            transport.getCommits.mockReturnValue(of([commit(1)]));
            mls.processMessage.mockReturnValue(of({
                kind: 'proposal', plaintext: null, selfRemoved: false,
                addedMembers: [], removedLeafIndices: [], senderIdentity: null, epoch: null,
            }));

            await sync.syncContext(CONTEXT, false);

            expect(mls.processMessage).toHaveBeenCalledTimes(1);
            expect(transport.getCommits).toHaveBeenCalledTimes(1);
        });

        it('keeps paging past a proposal to the commit behind it', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);

            // The proposal does not claim epoch 1, so the real commit that follows it is also at
            // epoch 1 and must still be applied. Treating the proposal as progress would have gone
            // looking for epoch 2 next and stopped at the gap.
            transport.getCommits
                .mockReturnValueOnce(of([commit(1), commit(1)]))
                .mockReturnValue(of([]));
            mls.processMessage
                .mockReturnValueOnce(of({
                    kind: 'proposal', plaintext: null, selfRemoved: false,
                    addedMembers: [], removedLeafIndices: [], senderIdentity: null, epoch: null,
                }))
                .mockReturnValue(of({
                    kind: 'commit', plaintext: null, selfRemoved: false,
                    addedMembers: [], removedLeafIndices: [], senderIdentity: null, epoch: 1,
                }));

            await sync.syncContext(CONTEXT, false);

            expect(mls.processMessage).toHaveBeenCalledTimes(2);
        });

        it('trusts the server\'s isProposal flag rather than what the bytes turn out to be', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);

            // The flagged row claims no epoch - the server's epoch index is filtered on
            // `is_proposal = false` - so the real commit behind it legitimately carries the *same*
            // epoch number. Inferring proposal-ness from the engine's verdict would mean applying
            // the bytes before being able to decide, which is exactly backwards.
            transport.getCommits
                .mockReturnValueOnce(of([
                    {...commit(1), isProposal: true},
                    {...commit(1), commit: 'cmVhbGNvbW1pdA=='},
                ]))
                .mockReturnValue(of([]));

            await sync.syncContext(CONTEXT, false);

            const applied = mls.processMessage.mock.calls.map(c => c[1]);
            expect(applied).toEqual(['Y29tbWl01', 'cmVhbGNvbW1pdA==']);
        });

        it('does not let a stale proposal abort the commits behind it', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getCommits
                .mockReturnValueOnce(of([
                    {...commit(1), isProposal: true},
                    {...commit(1), commit: 'cmVhbGNvbW1pdA=='},
                ]))
                .mockReturnValue(of([]));
            // A proposal is only valid in the epoch it was built against, so one arriving after the
            // group moved on simply fails - and must not take the whole catch-up down with it.
            mls.processMessage
                .mockReturnValueOnce(throwError(() => new Error('WrongEpoch')))
                .mockReturnValue(of({
                    kind: 'commit', plaintext: null, selfRemoved: false,
                    addedMembers: [], removedLeafIndices: [], senderIdentity: null, epoch: 1,
                }));

            await sync.syncContext(CONTEXT, false);

            expect(mls.processMessage).toHaveBeenCalledTimes(2);
        });

        it('replays messages that arrived before the commit that made them readable', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getCommits
                .mockReturnValueOnce(of([commit(1)]))
                .mockReturnValue(of([]));
            mls.drainPendingMessages.mockReturnValue(of([
                {messageId: 'msg-1', plaintext: 'aGk=', senderIdentity: 'user-2', epoch: 1},
            ]));

            const seen: string[] = [];
            sync.replayedMessages.subscribe(e => seen.push(...e.messages.map(m => m.messageId!)));

            await sync.syncContext(CONTEXT, false);

            // A message decrypts from the wire exactly once, so one that raced ahead of its commit
            // was lost outright rather than merely delayed.
            expect(seen).toEqual(['msg-1']);
        });

        it('tears down local state when a commit removes this device', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getCommits.mockReturnValue(of([commit(1), commit(2)]));
            mls.processMessage.mockReturnValue(of({
                kind: 'commit', plaintext: null, selfRemoved: true,
                addedMembers: [], removedLeafIndices: [0], senderIdentity: null, epoch: 1,
            }));

            const seen: boolean[] = [];
            sync.contextChanged.subscribe(e => seen.push(e.selfRemoved));

            await sync.syncContext(CONTEXT, false);

            // Keeping the group would let a stale UI claim it can still read the context, and would
            // keep key material around for a group we are no longer in.
            expect(mls.deleteGroup).toHaveBeenCalledWith(GROUP);
            expect(mls.clearActiveGeneration).toHaveBeenCalledWith(CONTEXT);
            expect(seen).toEqual([true]);
            expect(mls.processMessage).toHaveBeenCalledTimes(1);
        });
    });

    describe('publishing', () => {
        function seedGroup(mls: ReturnType<typeof makeMls>) {
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
        }

        it('merges only after the server accepts', async () => {
            const {sync, mls} = setup();
            seedGroup(mls);

            await sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [],
            }));

            expect(mls.mergePendingCommit).toHaveBeenCalledWith(GROUP);
            expect(mls.clearPendingCommit).not.toHaveBeenCalled();
        });

        it('discards the staged commit when the server rejects it', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);
            transport.publishCommit.mockReturnValue(
                throwError(() => new HttpErrorResponse({status: 409, error: {currentEpoch: 5}})),
            );

            await sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [],
            }));

            // Applying a commit the server refused forks this device off the group for good.
            expect(mls.clearPendingCommit).toHaveBeenCalledWith(GROUP);
            expect(mls.mergePendingCommit).not.toHaveBeenCalled();
        });

        it('catches up and re-issues once after a rejection', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);
            transport.publishCommit
                .mockReturnValueOnce(throwError(() => new HttpErrorResponse({status: 409, error: {}})))
                .mockReturnValueOnce(of({contextId: CONTEXT, generation: 1, epoch: 2}));

            const produce = vi.fn(async () => ({commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: []}));
            const ok = await sync.publish(CONTEXT, false, produce);

            expect(ok).toBe(true);
            expect(produce).toHaveBeenCalledTimes(2);
            expect(transport.getCommits).toHaveBeenCalled();
            expect(mls.mergePendingCommit).toHaveBeenCalledTimes(1);
        });

        it('gives up after a second rejection rather than looping', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);
            transport.publishCommit.mockReturnValue(
                throwError(() => new HttpErrorResponse({status: 409, error: {}})),
            );

            const ok = await sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [],
            }));

            expect(ok).toBe(false);
            expect(mls.clearPendingCommit).toHaveBeenCalledTimes(2);
        });

        it('rethrows a non-conflict failure instead of silently swallowing it', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);
            transport.publishCommit.mockReturnValue(
                throwError(() => new HttpErrorResponse({status: 500})),
            );

            await expect(sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [],
            }))).rejects.toBeInstanceOf(HttpErrorResponse);

            expect(mls.clearPendingCommit).toHaveBeenCalled();
        });

        it('carries welcomes alongside the commit that adds them', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);

            await sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0',
                epoch: 1,
                deviceWelcomes: [{deviceId: 'device-b', userId: 'user-2', welcome: 'd2VsY29tZQ=='}],
            }));

            // A device holding a leaf whose Welcome went missing can never derive the group's keys.
            const dto = transport.publishCommit.mock.calls[0][2];
            expect(dto.welcomes).toHaveLength(1);
            expect(dto.generation).toBe(1);
        });

        it('keeps the merged state when the publish landed but the merge threw', async () => {
            const {sync, mls} = setup();
            seedGroup(mls);
            mls.mergePendingCommit.mockReturnValue(throwError(() => new Error('disk full')));

            await expect(sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [],
            }))).rejects.toBeInstanceOf(Error);

            // The server has the commit. Discarding ours here - which the single catch around both
            // calls used to do - leaves this device permanently behind a commit everyone else
            // applied, and MLS has no way to rejoin an epoch you refused.
            expect(mls.clearPendingCommit).not.toHaveBeenCalled();
        });

        it('re-publishes rather than discarding when the response is lost', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);
            // A dropped response is indistinguishable from a rejection at the client. Publishing is
            // idempotent on (senderDeviceId, generation, epoch, payload) precisely so asking again
            // resolves it; the old code resolved it by throwing away a commit the server had taken.
            transport.publishCommit
                .mockReturnValueOnce(throwError(() => new HttpErrorResponse({status: 0})))
                .mockReturnValueOnce(of({contextId: CONTEXT, generation: 1, epoch: 1, duplicate: true}));

            const ok = await sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [],
            }));

            expect(ok).toBe(true);
            expect(transport.publishCommit).toHaveBeenCalledTimes(2);
            expect(mls.clearPendingCommit).not.toHaveBeenCalled();
            expect(mls.mergePendingCommit).toHaveBeenCalledWith(GROUP);
        });

        it('treats a duplicate replay as the success it is', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);
            transport.publishCommit
                .mockReturnValueOnce(throwError(() => new HttpErrorResponse({status: 0})))
                // `duplicate: true` is the server saying it matched this exact payload from this
                // device and returned the row it already held. The publish landed; only the
                // response was lost. Reading it as a lost race is what discarded commits the group
                // had already applied.
                .mockReturnValueOnce(of({
                    contextId: CONTEXT, generation: 1, epoch: 1, duplicate: true, isProposal: false,
                }));

            const ok = await sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [],
            }));

            expect(ok).toBe(true);
            expect(mls.mergePendingCommit).toHaveBeenCalledTimes(1);
            expect(mls.clearPendingCommit).not.toHaveBeenCalled();
        });

        it('publishes the GroupInfo the commit produced, not an exported one', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);

            await sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [], groupInfo: 'ZnJlc2hpbmZv',
            }));

            // An exported GroupInfo describes the epoch the group is on *now*, and the commit is
            // deliberately staged rather than merged at this point - so exporting here published a
            // blob one epoch stale, and a device recovering by external commit landed behind the
            // group it was trying to rejoin.
            const dto = transport.publishCommit.mock.calls[0][2];
            expect(dto.groupInfo).toBe('ZnJlc2hpbmZv');
            expect(mls.exportGroupInfo).not.toHaveBeenCalled();
        });

        it('re-applies a commit of ours the server hands back on catch-up without forking', async () => {
            const {sync, mls, transport} = setup();
            seedGroup(mls);
            transport.publishCommit
                .mockReturnValueOnce(throwError(() => new HttpErrorResponse({status: 409, error: {}})))
                .mockReturnValueOnce(of({contextId: CONTEXT, generation: 1, epoch: 2}));
            // The catch-up between the two attempts replays whatever won the epoch.
            transport.getCommits
                .mockReturnValueOnce(of([commit(1)]))
                .mockReturnValue(of([]));

            const ok = await sync.publish(CONTEXT, false, async () => ({
                commit: 'Y29tbWl0', epoch: 1, deviceWelcomes: [],
            }));

            expect(ok).toBe(true);
            // Discarded once for the lost race, merged once for the attempt that won. Merging a
            // commit the server refused, or discarding one it took, are both unrecoverable.
            expect(mls.clearPendingCommit).toHaveBeenCalledTimes(1);
            expect(mls.mergePendingCommit).toHaveBeenCalledTimes(1);
        });
    });

    describe('reading', () => {
        function seedGroup(mls: ReturnType<typeof makeMls>) {
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
        }

        it('returns the plaintext when the sender is a current member', async () => {
            const {sync, mls} = setup();
            seedGroup(mls);
            mls.processMessage.mockReturnValue(of({
                kind: 'application', plaintext: 'aGk=', selfRemoved: false,
                addedMembers: [], removedLeafIndices: [], senderIdentity: 'user-2', epoch: null,
            }));

            const plaintext = await sync.decryptMessage(
                CONTEXT, false, GROUP, 'Y2lwaGVy', 'msg-1', 'user-2');

            expect(plaintext).toBe('aGk=');
        });

        it('does not re-check the roster, because openmls already did', async () => {
            const {sync, mls} = setup();
            seedGroup(mls);
            mls.processMessage.mockReturnValue(of({
                kind: 'application', plaintext: 'aGk=', selfRemoved: false,
                addedMembers: [], removedLeafIndices: [], senderIdentity: 'user-2', epoch: null,
            }));

            const plaintext = await sync.decryptMessage(CONTEXT, false, GROUP, 'Y2lwaGVy', 'msg-1');

            // This used to fetch the roster and check the sender was in it, with a comment claiming
            // it stopped a malicious server spoofing a credential. openmls resolves the sender from
            // a leaf in the ratchet tree and verifies the signature against that leaf before
            // returning, so the lookup could only ever answer yes - a tautology dressed as a
            // security check, which is worse than none because it made the missing one look
            // present. Asserting the call is gone stops it being reinstated as reassurance.
            expect(plaintext).toBe('aGk=');
            expect(mls.getMembers).not.toHaveBeenCalled();
        });

        it('refuses a message whose credential disagrees with the claimed author', async () => {
            const {sync, mls} = setup();
            seedGroup(mls);
            mls.processMessage.mockReturnValue(of({
                kind: 'application', plaintext: 'aGk=', selfRemoved: false,
                addedMembers: [], removedLeafIndices: [], senderIdentity: 'user-2', epoch: null,
            }));

            // Only the credential inside the ciphertext is authenticated; the author on the
            // envelope is the server's word. A disagreement means neither is safe to attribute.
            const plaintext = await sync.decryptMessage(
                CONTEXT, false, GROUP, 'Y2lwaGVy', 'msg-1', 'user-9');

            expect(plaintext).toBeNull();
        });

        it('reports a context as unreadable after repeated decrypt failures', async () => {
            const {sync, mls, health} = setup();
            seedGroup(mls);
            mls.processMessage.mockReturnValue(throwError(() => new Error('WrongEpoch')));

            for (let i = 0; i < 3; i++) {
                await sync.decryptMessage(CONTEXT, false, GROUP, 'Y2lwaGVy', `msg-${i}`);
            }

            // Every one of these used to be a bare `catch {}`. A device that could read nothing
            // looked exactly like one with nothing to read.
            expect(health.isBroken(CONTEXT)).toBe(true);
        });

        it('says nothing about a context that reads fine', async () => {
            const {sync, mls, health} = setup();
            seedGroup(mls);
            mls.processMessage.mockReturnValue(of({
                kind: 'application', plaintext: 'aGk=', selfRemoved: false,
                addedMembers: [], removedLeafIndices: [], senderIdentity: 'user-2', epoch: null,
            }));

            await sync.decryptMessage(CONTEXT, false, GROUP, 'Y2lwaGVy', 'msg-1', 'user-2');

            expect(health.hasFailures()).toBe(false);
        });

        it('does not treat an early message as a failure', async () => {
            const {sync, mls, health} = setup();
            seedGroup(mls);
            mls.processMessage.mockReturnValue(of({
                kind: 'buffered', plaintext: null, selfRemoved: false,
                addedMembers: [], removedLeafIndices: [], senderIdentity: null, epoch: 5,
            }));

            const plaintext = await sync.decryptMessage(CONTEXT, false, GROUP, 'Y2lwaGVy', 'msg-1');

            // It is held, not lost - the drain replays it once its commit lands.
            expect(plaintext).toBeNull();
            expect(health.hasFailures()).toBe(false);
        });
    });

    describe('membership', () => {
        it('reports devices that could not be added', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.consumeTokensForUsers.mockReturnValue(of({
                deviceTokens: [{deviceId: 'device-b', userId: 'user-2', token: 'a2V5'}],
                unreachableDevices: [{userId: 'user-3', deviceId: 'device-c', deviceName: "Bob's phone"}],
            }));

            const unreachable = await sync.addMembers(CONTEXT, false, ['user-2', 'user-3']);

            // Silently dropping them leaves someone in a conversation they can never read.
            expect(unreachable).toHaveLength(1);
            expect(unreachable[0].deviceName).toBe("Bob's phone");
        });

        it('skips our own device when adding', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.consumeTokensForUsers.mockReturnValue(of({
                deviceTokens: [{deviceId: DEVICE_ID, userId: 'user-1', token: 'a2V5'}],
                unreachableDevices: [],
            }));

            await sync.addMembers(CONTEXT, false, ['user-1']);

            expect(mls.addMembers).not.toHaveBeenCalled();
        });

        it('drops local state on leave even if publishing the proposal fails', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.publishCommit.mockReturnValue(throwError(() => new HttpErrorResponse({status: 500})));

            await sync.leaveContext(CONTEXT, false);

            // Our own forward secrecy does not depend on anyone else committing the removal.
            expect(mls.leaveGroup).toHaveBeenCalled();
            expect(mls.clearActiveGeneration).toHaveBeenCalledWith(CONTEXT);
        });

        it('marks the leave payload as a proposal so it cannot claim an epoch', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);

            await sync.leaveContext(CONTEXT, false);

            // Unflagged, the server advanced the group to an epoch no client ever reaches, so every
            // member's catch-up re-fetched the same proposal forever and no commit was accepted
            // again - the group could never gain a member after anyone left it.
            const dto = transport.publishCommit.mock.calls[0][2];
            expect(dto.isProposal).toBe(true);
        });
    });

    describe('state reconciliation', () => {
        it('forgets the active generation when a never-encrypted context reports plaintext',
            async () => {
                const {sync, mls, transport} = setup();
                // Registry seeded directly, without `registerGroup`, so no floor exists - this is
                // a context this device has never actually encrypted anything in.
                mls.registry.set(`${CONTEXT}#1`, GROUP);
                mls.activeGeneration.set(CONTEXT, 1);
                transport.getState.mockReturnValue(of({
                    contextId: CONTEXT, encrypted: false, generations: [],
                }));

                await sync.refreshState(CONTEXT, false);

                expect(mls.clearActiveGeneration).toHaveBeenCalledWith(CONTEXT);
            });

        // ─── C1: the server must not be able to switch encryption off ─────────
        //
        // `state.encrypted` is a server field. Clearing the active generation on it made
        // `getKnownGeneration` return null, which made `mayPostCleartext(null, 'plain')` return
        // true, which put the next composed message on the wire in the clear. No group keys were
        // needed and no MLS property was broken; the client simply stopped using them because it
        // was asked to.

        it('refuses to clear the generation when the context has ever been encrypted here',
            async () => {
                const {sync, mls, transport} = setup();
                await mls.registerGroup(CONTEXT, 1, GROUP);
                transport.getState.mockReturnValue(of({
                    contextId: CONTEXT, encrypted: false, generations: [],
                }));

                await sync.refreshState(CONTEXT, false);

                expect(mls.clearActiveGeneration).not.toHaveBeenCalled();
                expect(await mls.getKnownGeneration(CONTEXT)).toBe(1);
            });

        it('reports a claimed downgrade as a failure the user can see', async () => {
            const {sync, mls, transport, health} = setup();
            await mls.registerGroup(CONTEXT, 1, GROUP);
            transport.getState.mockReturnValue(of({
                contextId: CONTEXT, encrypted: false, generations: [],
            }));

            await sync.refreshState(CONTEXT, false);

            expect(health.healthOf(CONTEXT)?.reason).toBe('downgraded');
            // Immediately broken, not after three strikes: there is no "hiccup" reading of this,
            // and the user has to see it before they type the next message.
            expect(health.isBroken(CONTEXT)).toBe(true);
        });

        it('keeps the floor even after the group is gone locally', async () => {
            const {sync, mls, transport} = setup();
            await mls.registerGroup(CONTEXT, 1, GROUP);
            await mls.clearActiveGeneration(CONTEXT);
            transport.getState.mockReturnValue(of({
                contextId: CONTEXT, encrypted: false, generations: [],
            }));

            await sync.refreshState(CONTEXT, false);

            // The device holds no group any more - removed, or wiped - and still must not compose
            // in the clear here. The floor outlives the keys on purpose.
            expect(await mls.getEncryptionFloor(CONTEXT)).toBe(1);
        });

        it('looks for a Welcome when the context moved to a generation we never joined', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getState.mockReturnValue(of({
                contextId: CONTEXT, encrypted: true, activeGeneration: 2, epoch: 0, generations: [],
            }));

            await sync.refreshState(CONTEXT, false);

            // Encryption was toggled off and back on while we were away - that is a brand new group,
            // and the only way in is a Welcome.
            expect(transport.getPendingWelcomes).toHaveBeenCalled();
        });

        it('just catches up when the generation is unchanged', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);

            await sync.refreshState(CONTEXT, false);

            expect(transport.getPendingWelcomes).not.toHaveBeenCalled();
            expect(transport.getCommits).toHaveBeenCalled();
        });
    });
});
