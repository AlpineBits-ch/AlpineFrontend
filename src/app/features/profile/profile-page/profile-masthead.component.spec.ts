import {DatePipe} from '@angular/common';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ProfileMastheadComponent} from './profile-masthead.component';
import {ProfileService} from '../../../services/profile.service';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

const OWN: ProfileDto = {
    id: 'prfl_own',
    createdAt: new Date('2020-06-15T12:00:00Z'),
    updatedAt: new Date(0),
    userName: 'fakePilotDominic',
    bio: undefined,
    userId: 'user-own',
    avatarUrl: undefined,
    bannerUrl: 'https://cdn.test.example/banner.png',
    accentColor: '#336699',
    font: ProfileFont.Default,
    onlineStatus: OnlineStatus.Online,
};

function setup(
    inputs: Partial<{
        profile: ProfileDto;
        editing: boolean;
        saving: boolean;
        uploadingAvatar: boolean;
        uploadingBanner: boolean;
        bio: string;
        accentColor: string;
        font: ProfileFont;
    }> = {},
) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [ProfileMastheadComponent],
        providers: [
            provideZonelessChangeDetection(),
            provideTranslateService(),
            provideFakePlatform(),
            {
                provide: ProfileService,
                useValue: {
                    getCachedByUserId: () => OWN,
                    resolveByUserId: () => undefined,
                },
            },
        ],
    });

    const fixture: ComponentFixture<ProfileMastheadComponent> =
        TestBed.createComponent(ProfileMastheadComponent);
    fixture.componentRef.setInput('profile', inputs.profile ?? OWN);
    fixture.componentRef.setInput('editing', inputs.editing ?? false);
    fixture.componentRef.setInput('saving', inputs.saving ?? false);
    fixture.componentRef.setInput('uploadingAvatar', inputs.uploadingAvatar ?? false);
    fixture.componentRef.setInput('uploadingBanner', inputs.uploadingBanner ?? false);
    fixture.componentRef.setInput('bio', inputs.bio ?? '');
    fixture.componentRef.setInput('accentColor', inputs.accentColor ?? '');
    fixture.componentRef.setInput('font', inputs.font ?? ProfileFont.Default);
    fixture.detectChanges();
    return fixture;
}

function el(fixture: ComponentFixture<unknown>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
}

function testId(fixture: ComponentFixture<unknown>, id: string): HTMLElement | null {
    return el(fixture).querySelector(`[data-testid="${id}"]`);
}

describe('ProfileMastheadComponent', () => {
    beforeEach(() => {
        // jsdom implements no `matchMedia`, and PrimeNG's Select/Dialog read it.
        if (!window.matchMedia) {
            window.matchMedia = ((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
                addListener: () => undefined,
                removeListener: () => undefined,
                dispatchEvent: () => false,
            })) as unknown as typeof window.matchMedia;
        }
    });

    it("renders the profile's banner, avatar and name", () => {
        const fixture = setup();

        expect(el(fixture).textContent).toContain('fakePilotDominic');
        expect(el(fixture).querySelector('app-avatar')).not.toBeNull();
        expect(el(fixture).querySelector('img[alt=""]')?.getAttribute('src')).toContain('banner.png');
    });

    it('falls back to the accent colour when there is no banner', () => {
        const fixture = setup({profile: {...OWN, bannerUrl: undefined}});
        const banner = el(fixture).querySelector('.h-32') as HTMLElement;

        expect(el(fixture).querySelector('img[alt=""]')).toBeNull();
        expect(banner.style.background).not.toBe('');
    });

    it('shows member since, in the app date format, in view mode', () => {
        const fixture = setup({editing: false});
        const expected = new DatePipe('en-US').transform(OWN.createdAt, 'MMM d, yyyy');

        expect(testId(fixture, 'member-since')?.textContent).toContain(expected);
    });

    it('keeps member since visible, unchanged, in edit mode', () => {
        const fixture = setup({editing: true});
        const expected = new DatePipe('en-US').transform(OWN.createdAt, 'MMM d, yyyy');

        expect(testId(fixture, 'member-since')?.textContent).toContain(expected);
    });

    it('view mode shows the Edit affordance and nothing editable', () => {
        const fixture = setup({editing: false});

        expect(testId(fixture, 'edit-profile')).not.toBeNull();
        expect(testId(fixture, 'bio-field')).toBeNull();
        expect(testId(fixture, 'change-avatar')).toBeNull();
        expect(testId(fixture, 'change-banner')).toBeNull();
    });

    it('editStarted fires from the Edit affordance', () => {
        const fixture = setup({editing: false});
        const editStarted = vi.fn();
        fixture.componentInstance.editStarted.subscribe(editStarted);
        testId(fixture, 'edit-profile')!.click();
        expect(editStarted).toHaveBeenCalledOnce();
    });

    it('cancelled and saved fire from the banner buttons in edit mode', () => {
        const fixture = setup({editing: true});
        const cancelled = vi.fn();
        const saved = vi.fn();
        fixture.componentInstance.cancelled.subscribe(cancelled);
        fixture.componentInstance.saved.subscribe(saved);

        testId(fixture, 'cancel-edit')!.click();
        expect(cancelled).toHaveBeenCalledOnce();

        testId(fixture, 'save-profile')!.click();
        expect(saved).toHaveBeenCalledOnce();
    });

    it('the bio field is seeded from the input and emits bioChanged on typing', async () => {
        const fixture = setup({editing: true, bio: 'already there'});
        await fixture.whenStable();
        const bioChanged = vi.fn();
        fixture.componentInstance.bioChanged.subscribe(bioChanged);

        const textarea: HTMLTextAreaElement = testId(fixture, 'bio-field') as HTMLTextAreaElement;
        expect(textarea.value).toBe('already there');

        textarea.value = 'a new bio';
        textarea.dispatchEvent(new Event('input'));
        fixture.detectChanges();

        expect(bioChanged).toHaveBeenCalledWith('a new bio');
    });

    it('the accent colour input emits accentColorChanged, and reset emits an empty string', () => {
        const fixture = setup({editing: true, accentColor: '#123456'});
        const accentColorChanged = vi.fn();
        fixture.componentInstance.accentColorChanged.subscribe(accentColorChanged);

        const input: HTMLInputElement = el(fixture).querySelector('input[type="color"]')!;
        input.value = '#abcdef';
        input.dispatchEvent(new Event('input'));
        expect(accentColorChanged).toHaveBeenCalledWith('#abcdef');

        testId(fixture, 'accent-reset')!.click();
        expect(accentColorChanged).toHaveBeenCalledWith('');
    });

    it('the remove-avatar control only shows in edit mode with an avatar set', () => {
        expect(
            testId(
                setup({editing: false, profile: {...OWN, avatarUrl: 'https://cdn.test.example/a.png'}}),
                'remove-avatar',
            ),
        ).toBeNull();
        expect(
            testId(setup({editing: true, profile: {...OWN, avatarUrl: undefined}}), 'remove-avatar'),
        ).toBeNull();
        expect(
            testId(
                setup({editing: true, profile: {...OWN, avatarUrl: 'https://cdn.test.example/a.png'}}),
                'remove-avatar',
            ),
        ).not.toBeNull();
    });

    it('avatarRemoveRequested fires from the remove-avatar control', () => {
        const fixture = setup({
            editing: true,
            profile: {...OWN, avatarUrl: 'https://cdn.test.example/a.png'},
        });
        const avatarRemoveRequested = vi.fn();
        fixture.componentInstance.avatarRemoveRequested.subscribe(avatarRemoveRequested);

        testId(fixture, 'remove-avatar')!.click();

        expect(avatarRemoveRequested).toHaveBeenCalledOnce();
    });

    it('avatarCropped and bannerCropped emit the cropped file and close their dialogs', () => {
        const fixture = setup({editing: true});
        const avatarCropped = vi.fn();
        const bannerCropped = vi.fn();
        fixture.componentInstance.avatarCropped.subscribe(avatarCropped);
        fixture.componentInstance.bannerCropped.subscribe(bannerCropped);

        const file = new File(['x'], 'avatar.png', {type: 'image/png'});
        const instance = fixture.componentInstance as unknown as {
            onAvatarCropConfirmed(file: File): void;
            onBannerCropConfirmed(file: File): void;
            avatarCropVisible: () => boolean;
            bannerCropVisible: () => boolean;
        };

        instance.onAvatarCropConfirmed(file);
        expect(avatarCropped).toHaveBeenCalledWith(file);
        expect(instance.avatarCropVisible()).toBe(false);

        instance.onBannerCropConfirmed(file);
        expect(bannerCropped).toHaveBeenCalledWith(file);
        expect(instance.bannerCropVisible()).toBe(false);
    });
});
