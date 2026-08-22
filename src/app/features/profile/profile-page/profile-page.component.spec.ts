import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal, WritableSignal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {ProfilePageComponent} from './profile-page.component';
import {ProfileService} from '../../../services/profile.service';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileCanvasStore} from '../../../stores/profile-canvas.store';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

const OWN: ProfileDto = {
    id: 'prfl_own',
    createdAt: new Date(0),
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

function setup(initial: ProfileDto | undefined) {
    const ownProfile: WritableSignal<ProfileDto | undefined> = signal(initial);
    const ensureLoadedCalls: string[] = [];

    TestBed.configureTestingModule({
        imports: [ProfilePageComponent],
        providers: [
            provideZonelessChangeDetection(),
            provideTranslateService(),
            provideFakePlatform(),
            {
                provide: ProfileService,
                useValue: {
                    ownProfile,
                    getCachedByUserId: () => ownProfile(),
                    resolveByUserId: () => undefined,
                },
            },
            {
                provide: ProfileCanvasStore,
                useValue: {
                    canvasFor: () => undefined,
                    ensureLoaded: (id: string) => ensureLoadedCalls.push(id),
                },
            },
        ],
    });

    const fixture: ComponentFixture<ProfilePageComponent> = TestBed.createComponent(ProfilePageComponent);
    fixture.detectChanges();
    return {fixture, ownProfile, editor: TestBed.inject(CanvasEditorService), ensureLoadedCalls};
}

function text(fixture: ComponentFixture<unknown>): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

describe('ProfilePageComponent', () => {
    afterEach(() => TestBed.resetTestingModule());

    it("renders the own profile's banner, avatar and name", () => {
        const {fixture} = setup(OWN);
        const el = fixture.nativeElement as HTMLElement;

        expect(text(fixture)).toContain('fakePilotDominic');
        expect(el.querySelector('app-avatar')).not.toBeNull();
        expect(el.querySelector('img[alt=""]')?.getAttribute('src')).toContain('banner.png');
    });

    it('falls back to the accent colour when there is no banner', () => {
        const {fixture} = setup({...OWN, bannerUrl: undefined});
        const el = fixture.nativeElement as HTMLElement;
        const banner = el.querySelector('.h-48') as HTMLElement;

        expect(el.querySelector('img[alt=""]')).toBeNull();
        expect(banner.style.background).not.toBe('');
        expect(banner.style.background).not.toBe('none');
    });

    it('shows a loading state instead of throwing when there is no profile yet', () => {
        let fixture!: ComponentFixture<ProfilePageComponent>;
        expect(() => (fixture = setup(undefined).fixture)).not.toThrow();

        expect(fixture.nativeElement.querySelector('app-avatar')).toBeNull();
        expect(text(fixture)).not.toContain('fakePilotDominic');
        expect(fixture.nativeElement.querySelector('[role="status"]')).not.toBeNull();
    });

    it('keeps an unsaved draft when an unrelated profile write lands', () => {
        const {fixture, ownProfile, editor} = setup(OWN);
        editor.insert('marquee');
        fixture.detectChanges();
        expect(editor.dirty()).toBe(true);

        // Same id, a fresh object: exactly what ProfileService.ownProfile hands out after
        // updateProfile() / uploadAvatar() / uploadBanner() / setSelfStatus().
        ownProfile.set({...OWN, bio: 'a new bio'});
        fixture.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(1);
        expect(editor.dirty()).toBe(true);
    });

    it('re-begins the draft when the profile id actually changes', () => {
        const {fixture, ownProfile, editor} = setup(OWN);
        editor.insert('marquee');
        fixture.detectChanges();
        expect(editor.draft()!.widgets).toHaveLength(1);

        ownProfile.set({...OWN, id: 'prfl_other'});
        fixture.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(0);
        expect(editor.dirty()).toBe(false);
    });
});
