import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ProfileModalComponent} from './profile-modal.component';
import {ProfilePopoutService} from '../../services/profile-popout.service';
import {ProfileService} from '../../services/profile.service';
import {MutualsNotVisibleError, MutualsService} from '../../services/mutuals.service';
import {DirectMessageService} from '../../services/direct-message.service';
import {UserActivityService} from '../../services/user-activity.service';
import {NavigationService} from '../../features/main-page/navigation.service';
import {GuildService} from '../../services/guild.service';
import {RelationshipStore} from '../../stores/relationship.store';
import {ReportDialogService} from '../../services/report-dialog.service';
import {ToastService} from '../../services/toast.service';
import {BrokenImageService} from '../../services/broken-image.service';
import {OsInfo} from '../../platform/ports/os-info.port';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../dtos/response/profile.dto';
import {signal} from '@angular/core';
import {ProfileCanvasStore} from '../../stores/profile-canvas.store';
import {ProfileCanvasApiService} from '../../services/profile-canvas-api.service';
import {ProfileCanvasDto} from '../../dtos/response/profile-canvas.dto';

const USER_ID = 'user-subject';

function profile(overrides: Partial<ProfileDto> = {}): ProfileDto {
    return {
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
        ...overrides,
    };
}

describe('ProfileModalComponent', () => {
    let fixture: ComponentFixture<ProfileModalComponent>;
    let popoutSvc: ProfilePopoutService;
    let friends: ReturnType<typeof vi.fn>;
    let servers: ReturnType<typeof vi.fn>;
    let cached: ProfileDto;
    let canvas: ProfileCanvasDto;

    function openOn(tab: 'canvas' | 'activity' | 'friends' | 'servers' = 'activity'): void {
        popoutSvc.openModal(USER_ID, tab);
        fixture.detectChanges();
    }

    function canvasWith(widgetCount: number): ProfileCanvasDto {
        return {
            profileId: 'prfl_1',
            updatedAt: '',
            version: 1,
            theme: {accent: null, backdrop: null},
            widgets: Array.from({length: widgetCount}, (_, i) => ({
                id: `w${i}`,
                type: 'quote',
                x: 0,
                y: i,
                w: 2,
                h: 1,
                visibility: 'everyone' as const,
                card: false,
                config: {text: 'a line'},
            })),
        };
    }

    function tabLabels(): string[] {
        return [
            ...fixture.nativeElement.querySelectorAll(
                '[role="dialog"] > div:last-child > div:first-child button',
            ),
        ].map(b => (b as HTMLElement).textContent?.trim() ?? '');
    }

    beforeEach(() => {
        cached = profile();
        canvas = canvasWith(0);
        friends = vi.fn().mockReturnValue(of({items: [], nextCursor: null}));
        servers = vi.fn().mockReturnValue(of({items: [], nextCursor: null}));

        TestBed.configureTestingModule({
            providers: [
                provideTranslateService(),
                {provide: ProfileCanvasApiService, useValue: {imageUrl: (id: string) => `img/${id}`}},
                {
                    provide: ProfileCanvasStore,
                    useValue: {canvasFor: () => canvas, ensureLoaded: () => undefined},
                },
                {
                    provide: ProfileService,
                    useValue: {
                        getCachedByUserId: () => cached,
                        getByUserId: () => of(cached),
                        resolveByUserId: () => undefined,
                        ownProfile: signal({userId: 'user-own'}),
                    },
                },
                {
                    provide: MutualsService,
                    useValue: {friends, servers, guildIconUrl: (id: string) => `icon/${id}`},
                },
                {provide: DirectMessageService, useValue: {openOrCreateAndNavigate: vi.fn()}},
                {provide: UserActivityService, useValue: {activitiesFor: () => []}},
                {provide: NavigationService, useValue: {selectServer: vi.fn()}},
                {provide: GuildService, useValue: {getGuild: vi.fn()}},
                {
                    provide: RelationshipStore,
                    useValue: {blocked: signal([]), block: vi.fn(), unblock: vi.fn()},
                },
                {provide: ReportDialogService, useValue: {open: vi.fn()}},
                {provide: ToastService, useValue: {success: vi.fn(), error: vi.fn(), httpError: vi.fn()}},
                {provide: BrokenImageService, useValue: {isBroken: () => false, markBroken: vi.fn()}},
                {provide: OsInfo, useValue: {isMobile: false}},
            ],
        });

        popoutSvc = TestBed.inject(ProfilePopoutService);
        fixture = TestBed.createComponent(ProfileModalComponent);
    });

    it('offers only the Activity tab when neither mutual key is present', () => {
        openOn();

        expect(tabLabels()).toEqual(['PROFILE.TAB_ACTIVITY']);
    });

    it('offers a mutuals tab only when its list is non-empty', () => {
        cached = profile({
            mutualFriends: [{profileId: 'p', userId: 'u', userName: 'ann'}],
            mutualServers: [],
        });

        openOn();

        expect(tabLabels()).toEqual(['PROFILE.TAB_ACTIVITY', 'PROFILE.MUTUAL_FRIENDS']);
    });

    it('does not fetch a list for a tab that was never opened', () => {
        cached = profile({mutualFriends: [{profileId: 'p', userId: 'u', userName: 'ann'}]});

        openOn('activity');

        expect(friends).not.toHaveBeenCalled();
    });

    it('fetches once and keeps the page when a tab is left and returned to', () => {
        cached = profile({mutualFriends: [{profileId: 'p', userId: 'u', userName: 'ann'}]});
        friends.mockReturnValue(
            of({
                items: [
                    {
                        profileId: 'p',
                        userId: 'u',
                        userName: 'ann',
                        avatarUrl: 'a',
                        onlineStatus: OnlineStatus.Online,
                    },
                ],
                nextCursor: null,
            }),
        );

        openOn('friends');
        const component = fixture.componentInstance as unknown as {selectTab(t: string): void};
        component.selectTab('activity');
        fixture.detectChanges();
        component.selectTab('friends');
        fixture.detectChanges();

        expect(friends).toHaveBeenCalledOnce();
        expect(fixture.nativeElement.textContent).toContain('ann');
    });

    it('removes the tab when the server says the list is not visible', () => {
        cached = profile({mutualFriends: [{profileId: 'p', userId: 'u', userName: 'ann'}]});
        friends.mockReturnValue(throwError(() => new MutualsNotVisibleError()));

        openOn('friends');

        expect(tabLabels()).toEqual(['PROFILE.TAB_ACTIVITY']);
    });

    it('offers a retry rather than removing the tab when the fetch simply failed', () => {
        cached = profile({mutualFriends: [{profileId: 'p', userId: 'u', userName: 'ann'}]});
        friends.mockReturnValue(throwError(() => new Error('offline')));

        openOn('friends');

        expect(tabLabels()).toContain('PROFILE.MUTUAL_FRIENDS');
        expect(fixture.nativeElement.textContent).toContain('PROFILE.MUTUALS_RETRY');
    });

    it('shows the canvas tab and draws it when the subject has widgets', () => {
        canvas = canvasWith(1);
        openOn();

        expect(tabLabels()).toContain('PROFILE.CANVAS.TAB');
        expect(fixture.nativeElement.querySelector('app-profile-canvas')).not.toBeNull();
    });

    it('offers no canvas tab when the subject has never arranged one', () => {
        canvas = canvasWith(0);
        openOn();

        expect(tabLabels()).not.toContain('PROFILE.CANVAS.TAB');
        expect(fixture.nativeElement.querySelector('app-profile-canvas')).toBeNull();
    });

    it('falls back to activity when a canvas tab is asked for and there is none', () => {
        canvas = canvasWith(0);
        openOn('canvas');

        expect(fixture.nativeElement.querySelector('app-profile-canvas')).toBeNull();
        expect(fixture.nativeElement.textContent).toContain('PROFILE.NO_ACTIVITY');
    });
});
