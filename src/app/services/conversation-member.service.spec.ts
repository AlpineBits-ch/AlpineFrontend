import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {ConversationMemberService} from './conversation-member.service';
import {ConversationService} from './conversation.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';

const CONVERSATION = 'conv-1';

function setup(knownGeneration: number | null) {
    const calls: string[] = [];

    const conversations = {
        addMember: vi.fn(() => {
            calls.push('addMember');
            return of({id: CONVERSATION} as never);
        }),
    };
    const mls = {
        getKnownGeneration: vi.fn(async () => knownGeneration),
    };
    const sync = {
        addMembers: vi.fn(async () => {
            calls.push('mlsAddMembers');
            return [];
        }),
    };

    TestBed.configureTestingModule({
        providers: [
            ConversationMemberService,
            {provide: ConversationService, useValue: conversations},
            {provide: MlsService, useValue: mls},
            {provide: MlsSyncService, useValue: sync},
        ],
    });

    return {service: TestBed.inject(ConversationMemberService), conversations, sync, calls};
}

describe('ConversationMemberService', () => {
    it('does not touch MLS for a plaintext conversation', async () => {
        const {service, sync} = setup(null);

        await service.addMember(CONVERSATION, 'user-2');

        expect(sync.addMembers).not.toHaveBeenCalled();
    });

    it('admits the new member to the group when the conversation is encrypted', async () => {
        const {service, sync} = setup(1);

        await service.addMember(CONVERSATION, 'user-2');

        expect(sync.addMembers).toHaveBeenCalledWith(CONVERSATION, false, ['user-2']);
    });

    it('adds to the roster before admitting to the group', async () => {
        const {service, calls} = setup(1);

        await service.addMember(CONVERSATION, 'user-2');

        // The reverse order would leave someone holding group keys for a conversation the server
        // does not believe they are in - able to decrypt traffic they are not a member of.
        expect(calls).toEqual(['addMember', 'mlsAddMembers']);
    });

    it('reports devices that could not be admitted', async () => {
        const {service, sync} = setup(1);
        sync.addMembers = vi.fn(async () => [
            {userId: 'user-2', deviceId: 'device-b', deviceName: "Bob's phone"},
        ]) as never;

        const result = await service.addMember(CONVERSATION, 'user-2');

        // They are in the conversation but cannot read it - saying so beats letting them find out
        // when the history stays empty.
        expect(result.unreachableDevices).toHaveLength(1);
    });

    it('surfaces a rejected roster add without touching MLS', async () => {
        const {service, conversations, sync} = setup(1);
        conversations.addMember = vi.fn(() => {
            throw new Error('not friends');
        }) as never;

        await expect(service.addMember(CONVERSATION, 'stranger')).rejects.toThrow();
        expect(sync.addMembers).not.toHaveBeenCalled();
    });
});
