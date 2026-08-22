import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {of, Subject, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ProfilePopoutComponent} from './profile-popout.component';
import {ProfilePopoutService} from '../../services/profile-popout.service';
import {ProfileService} from '../../services/profile.service';
import {DirectMessageService} from '../../services/direct-message.service';
import {MessagingService} from '../../services/messaging.service';
import {NavigationService} from '../../features/main-page/navigation.service';
import {RelationshipStore} from '../../stores/relationship.store';
import {ReportDialogService} from '../../services/report-dialog.service';
import {ToastService} from '../../services/toast.service';
import {BrokenImageService} from '../../services/broken-image.service';
import {OsInfo} from '../../platform/ports/os-info.port';
import {ConversationDto} from '../../dtos/response/conversation.dto';
import {ConversationEncryption} from '../../enums/conversation-encryption.enum';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../dtos/response/profile.dto';
import {ProfileCanvasStore} from '../../stores/profile-canvas.store';
import {ProfileCanvasApiService} from '../../services/profile-canvas-api.service';
import {ProfileCanvasDto} from '../../dtos/response/profile-canvas.dto';

const USER_ID = 'user-subject';

const PROFILE: ProfileDto = {
    id: 'prfl_1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    userName: 'subject',
    bio: undefined,
    userId: USER_ID,
    avatarUrl: undefined,
    bannerUrl: undefined,
    accentColor: null,
    font: ProfileFont.Default,
    onlineStatus: OnlineStatus.Online,
};

const CONVERSATION: ConversationDto = {
    id: 'conv-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    name: undefined,
    members: [],
    encryptionState: ConversationEncryption.Plain,
};

describe('ProfilePopoutComponent', () => {
    let fixture: ComponentFixture<ProfilePopoutComponent>;
    let popoutSvc: ProfilePopoutService;
    let openOrCreate: ReturnType<typeof vi.fn>;
    let createMessage: ReturnType<typeof vi.fn>;
    let openConversation: ReturnType<typeof vi.fn>;
    let reportFailure: ReturnType<typeof vi.fn>;
    let canvas: ProfileCanvasDto | undefined;
    let ensureLoaded: ReturnType<typeof vi.fn>;

    function canvasWith(card: boolean): ProfileCanvasDto {
        return {
            profileId: 'prfl_1',
            updatedAt: '',
            version: 1,
            theme: {accent: null, backdrop: null},
            widgets: [
                {
                    id: 'w0',
                    type: 'quote',
                    x: 0,
                    y: 0,
                    w: 2,
                    h: 1,
                    visibility: 'everyone',
                    card,
                    config: {text: 'a line'},
                },
            ],
        };
    }

    function input(): HTMLInputElement {
        return fixture.nativeElement.querySelector('input');
    }

    function type(text: string): void {
        const el = input();
        el.value = text;
        el.dispatchEvent(new Event('input'));
        fixture.detectChanges();
    }

    function pressEnter(): void {
        input().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        fixture.detectChanges();
    }

    beforeEach(() => {
        openOrCreate = vi.fn().mockReturnValue(of(CONVERSATION));
        createMessage = vi.fn().mockReturnValue(of({}));
        openConversation = vi.fn();
        reportFailure = vi.fn();
        canvas = undefined;
        ensureLoaded = vi.fn();

        TestBed.configureTestingModule({
            providers: [
                provideTranslateService(),
                {
                    provide: ProfileService,
                    useValue: {
                        getCachedByUserId: () => PROFILE,
                        getByUserId: () => of(PROFILE),
                        resolveByUserId: () => undefined,
                        ownProfile: signal({userId: 'user-own'}),
                    },
                },
                {provide: DirectMessageService, useValue: {openOrCreate, reportFailure}},
                {provide: MessagingService, useValue: {createMessage}},
                {provide: NavigationService, useValue: {openConversation}},
                {
                    provide: RelationshipStore,
                    useValue: {blocked: signal([]), block: vi.fn(), unblock: vi.fn()},
                },
                {provide: ReportDialogService, useValue: {open: vi.fn()}},
                {provide: ToastService, useValue: {success: vi.fn(), error: vi.fn(), httpError: vi.fn()}},
                {provide: BrokenImageService, useValue: {isBroken: () => false, markBroken: vi.fn()}},
                {provide: OsInfo, useValue: {isMobile: false}},
                {provide: ProfileCanvasApiService, useValue: {imageUrl: (id: string) => `img/${id}`}},
                {provide: ProfileCanvasStore, useValue: {canvasFor: () => canvas, ensureLoaded}},
            ],
        });

        popoutSvc = TestBed.inject(ProfilePopoutService);
        fixture = TestBed.createComponent(ProfilePopoutComponent);
        popoutSvc.open(USER_ID);
        fixture.detectChanges();
    });

    it('sends the draft, then goes to the conversation and closes', () => {
        type('hello');
        pressEnter();

        expect(openOrCreate).toHaveBeenCalledWith(USER_ID);
        expect(createMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: 'conv-1',
                content: 'hello',
            }),
        );
        expect(openConversation).toHaveBeenCalledWith(CONVERSATION);
        expect(popoutSvc.popout()).toBeNull();
    });

    it('ignores an empty draft', () => {
        type('   ');
        pressEnter();

        expect(openOrCreate).not.toHaveBeenCalled();
    });

    it('disables the input while the send is in flight', () => {
        const pending = new Subject<ConversationDto>();
        openOrCreate.mockReturnValue(pending);

        type('hello');
        pressEnter();

        expect(input().disabled).toBe(true);
    });

    it('does not send twice when Enter is pressed again mid-flight', () => {
        openOrCreate.mockReturnValue(new Subject<ConversationDto>());

        type('hello');
        pressEnter();
        pressEnter();

        expect(openOrCreate).toHaveBeenCalledOnce();
    });

    it('keeps the draft and stays open when the conversation cannot be opened', () => {
        const err = new Error('refused');
        openOrCreate.mockReturnValue(throwError(() => err));

        type('hello');
        pressEnter();

        expect(reportFailure).toHaveBeenCalledWith(err);
        expect(popoutSvc.popout()).not.toBeNull();
        expect(input().value).toBe('hello');
        expect(input().disabled).toBe(false);
    });

    it('still navigates when the send fails after the conversation was created', () => {
        const err = new Error('send failed');
        createMessage.mockReturnValue(throwError(() => err));

        type('hello');
        pressEnter();

        expect(reportFailure).toHaveBeenCalledWith(err);
        expect(openConversation).toHaveBeenCalledWith(CONVERSATION);
    });

    it('hands the mutuals line over to the modal on the tab that was clicked', () => {
        const component = fixture.componentInstance as unknown as {
            openMutuals(tab: 'friends' | 'servers'): void;
        };

        component.openMutuals('servers');

        expect(popoutSvc.popout()).toBeNull();
        expect(popoutSvc.modal()).toEqual({userId: USER_ID, tab: 'servers'});
    });

    it('draws card widgets the store already holds', () => {
        canvas = canvasWith(true);
        popoutSvc.open(USER_ID);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('app-profile-canvas')).not.toBeNull();
    });

    it('draws nothing when the canvas has no card widgets', () => {
        canvas = canvasWith(false);
        popoutSvc.open(USER_ID);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('app-profile-canvas')).toBeNull();
    });

    it('draws nothing when the store is cold', () => {
        canvas = undefined;
        popoutSvc.open(USER_ID);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('app-profile-canvas')).toBeNull();
    });

    it('never asks the store to load a canvas', () => {
        canvas = canvasWith(true);
        popoutSvc.open(USER_ID);
        fixture.detectChanges();

        expect(ensureLoaded).not.toHaveBeenCalled();
    });
});
