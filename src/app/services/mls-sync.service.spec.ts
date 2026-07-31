import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, of, throwError} from 'rxjs';
import {MlsSyncService} from './mls-sync.service';
import {MlsProcessedMessage, MlsService} from './mls.service';
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
    const epochs = new Map<string, number>();
    const calls: string[] = [];

    return {
        calls,
        registry,
        activeGeneration,
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
        }),
        clearActiveGeneration: vi.fn(async (contextId: string) => {
            activeGeneration.delete(contextId);
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
        addMembers: vi.fn(() => of({commit: 'Y29tbWl0', welcome: 'd2VsY29tZQ==', epoch: 1})),
        removeMembers: vi.fn(() => of({commit: 'Y29tbWl0', welcome: null, epoch: 1})),
        commitPendingProposals: vi.fn(() => of({commit: 'Y29tbWl0', welcome: null, epoch: 1})),
        leaveGroup: vi.fn(() => of({commit: 'cHJvcG9zYWw=', welcome: null, epoch: 0})),
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
        ],
    });

    return {sync: TestBed.inject(MlsSyncService), mls, transport};
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
            expect(transport.ackWelcomes).toHaveBeenCalledWith(['pewe_1']);
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

            expect(transport.ackWelcomes).toHaveBeenCalledWith(['pewe_good']);
        });

        it('acknowledges a generation it already joined instead of re-joining forever', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            transport.getPendingWelcomes.mockReturnValue(of([welcome()]));

            await sync.processPendingWelcomes();

            // A previous run joined but died before acking. Re-joining would fail every time.
            expect(mls.joinGroup).not.toHaveBeenCalled();
            expect(transport.ackWelcomes).toHaveBeenCalledWith(['pewe_1']);
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
    });

    describe('state reconciliation', () => {
        it('forgets the active generation when the context turned plaintext', async () => {
            const {sync, mls, transport} = setup();
            mls.registry.set(`${CONTEXT}#1`, GROUP);
            mls.activeGeneration.set(CONTEXT, 1);
            transport.getState.mockReturnValue(of({
                contextId: CONTEXT, encrypted: false, generations: [],
            }));

            await sync.refreshState(CONTEXT, false);

            expect(mls.clearActiveGeneration).toHaveBeenCalledWith(CONTEXT);
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
