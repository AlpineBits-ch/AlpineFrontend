import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {HomeComponent} from './home.component';
import {ConversationService} from '../../../../services/conversation.service';
import {ConversationStore} from '../../../../stores/conversation.store';
import {RelationshipStore} from '../../../../stores/relationship.store';
import {ProfileService} from '../../../../services/profile.service';
import {NavigationService} from '../../navigation.service';
import {ToastService} from '../../../../services/toast.service';
import {UserActivityService} from '../../../../services/user-activity.service';
import {ProfilePopoutService} from '../../../../services/profile-popout.service';
import {ConversationDto} from '../../../../dtos/response/conversation.dto';
import {ConversationEncryption} from '../../../../enums/conversation-encryption.enum';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';

const OWN_ID = 'user-own';
const TARGET_ID = 'user-target';

function member(userId: string) {
    return {
        id: `memb-${userId}`,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        userId,
        cachedUserName: userId,
        lastReadMessageId: undefined,
        mentionCount: 0,
    };
}

function conversation(id: string, userIds: string[]): ConversationDto {
    return {
        id,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        name: undefined,
        members: userIds.map(member),
        encryptionState: ConversationEncryption.Plain,
    };
}

/**
 * Characterization of `HomeComponent.openOrCreateDm` as it behaves today, written before the body
 * moves to a shared service so the move can be shown to change nothing.
 */
describe('HomeComponent.openOrCreateDm', () => {
    let entities: ReturnType<typeof signal<ConversationDto[]>>;
    let createConversation: ReturnType<typeof vi.fn>;
    let addConversation: ReturnType<typeof vi.fn>;
    let openConversation: ReturnType<typeof vi.fn>;
    let toastError: ReturnType<typeof vi.fn>;
    let httpError: ReturnType<typeof vi.fn>;

    function build(): HomeComponent {
        return TestBed.runInInjectionContext(() => new HomeComponent());
    }

    beforeEach(() => {
        entities = signal<ConversationDto[]>([]);
        createConversation = vi.fn();
        addConversation = vi.fn();
        openConversation = vi.fn();
        toastError = vi.fn();
        httpError = vi.fn();

        TestBed.configureTestingModule({
            providers: [
                provideTranslateService(),
                {provide: ConversationService, useValue: {createConversation}},
                {provide: ConversationStore, useValue: {entities, addConversation}},
                {
                    provide: RelationshipStore,
                    useValue: {
                        incoming: signal([]),
                        outgoing: signal([]),
                        friends: signal([]),
                        blocked: signal([]),
                        pendingCount: signal(0),
                        load: vi.fn(),
                    },
                },
                {
                    provide: ProfileService,
                    useValue: {
                        ownProfile: signal({userId: OWN_ID}),
                        getOnlineStatus: () => OnlineStatus.Offline,
                    },
                },
                {provide: NavigationService, useValue: {openConversation}},
                {provide: ToastService, useValue: {error: toastError, httpError}},
                {provide: UserActivityService, useValue: {primaryFor: () => null, activitiesFor: () => []}},
                {provide: ProfilePopoutService, useValue: {open: vi.fn(), close: vi.fn()}},
            ],
        });

        vi.spyOn(TestBed.inject(TranslateService), 'instant').mockImplementation(
            (key: unknown) => `t:${key}`,
        );
    });

    it('reuses an existing two member conversation without calling the server', () => {
        const existing = conversation('conv-existing', [OWN_ID, TARGET_ID]);
        entities.set([existing]);

        build().openOrCreateDm(TARGET_ID);

        expect(createConversation).not.toHaveBeenCalled();
        expect(openConversation).toHaveBeenCalledWith(existing);
    });

    it('ignores a group conversation that merely contains both of them', () => {
        entities.set([conversation('conv-group', [OWN_ID, TARGET_ID, 'user-third'])]);
        createConversation.mockReturnValue(
            of({conversation: conversation('conv-new', [OWN_ID, TARGET_ID]), existing: false}),
        );

        build().openOrCreateDm(TARGET_ID);

        expect(createConversation).toHaveBeenCalledOnce();
    });

    it('creates a plain conversation, stores it and opens it', () => {
        const created = conversation('conv-new', [OWN_ID, TARGET_ID]);
        createConversation.mockReturnValue(of({conversation: created, existing: false}));

        build().openOrCreateDm(TARGET_ID);

        expect(createConversation).toHaveBeenCalledWith({
            members: [{userId: TARGET_ID}],
            name: undefined,
            encryption: ConversationEncryption.Plain,
            deviceWelcomes: [],
        });
        expect(addConversation).toHaveBeenCalledWith(created);
        expect(openConversation).toHaveBeenCalledWith(created);
    });

    it('reports a DM policy refusal as a translated message', () => {
        createConversation.mockReturnValue(
            throwError(
                () =>
                    new HttpErrorResponse({
                        status: 403,
                        error: {code: 'recipient_dm_policy'},
                    }),
            ),
        );

        build().openOrCreateDm(TARGET_ID);

        expect(toastError).toHaveBeenCalledWith('t:MESSAGING.REFUSED_DM_POLICY');
        expect(openConversation).not.toHaveBeenCalled();
    });

    it('falls back to the generic error for a failure that is not a refusal', () => {
        const err = new HttpErrorResponse({status: 500});
        createConversation.mockReturnValue(throwError(() => err));

        build().openOrCreateDm(TARGET_ID);

        expect(httpError).toHaveBeenCalledWith('Could not open that conversation', err);
    });
});
