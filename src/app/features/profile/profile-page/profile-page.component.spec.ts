import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal, WritableSignal} from '@angular/core';
import {By} from '@angular/platform-browser';
import {Router} from '@angular/router';
import {provideTranslateService} from '@ngx-translate/core';
import {ConfirmationService, MessageService} from 'primeng/api';
import {Select} from 'primeng/select';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {ProfilePageComponent} from './profile-page.component';
import {ProfileService} from '../../../services/profile.service';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileEditDraftService} from '../../../services/profile-edit-draft.service';
import {ProfileCanvasStore} from '../../../stores/profile-canvas.store';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';
import {FONT_OPTIONS, FONT_STACKS} from '../../../models/profile-font.model';
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
    const updateProfileCalls: unknown[] = [];
    const saveCanvasCalls: unknown[] = [];
    const navigateCalls: unknown[] = [];

    TestBed.configureTestingModule({
        imports: [ProfilePageComponent],
        providers: [
            provideZonelessChangeDetection(),
            provideTranslateService(),
            provideFakePlatform(),
            MessageService,
            {provide: Router, useValue: {navigate: (...args: unknown[]) => navigateCalls.push(args)}},
            {
                provide: ProfileService,
                useValue: {
                    ownProfile,
                    getCachedByUserId: () => ownProfile(),
                    resolveByUserId: () => undefined,
                    updateProfile: (patch: unknown) => {
                        updateProfileCalls.push(patch);
                        const current = ownProfile();
                        const saved = {...current, ...(patch as object)} as ProfileDto;
                        return of(saved);
                    },
                    uploadAvatar: () => of(ownProfile()),
                    uploadBanner: () => of(ownProfile()),
                },
            },
            {
                provide: ProfileCanvasStore,
                useValue: {
                    canvasFor: () => undefined,
                    ensureLoaded: (id: string) => ensureLoadedCalls.push(id),
                    saving: signal(false),
                    save: (canvas: unknown) => {
                        saveCanvasCalls.push(canvas);
                        return of(canvas);
                    },
                },
            },
        ],
    });

    const fixture: ComponentFixture<ProfilePageComponent> = TestBed.createComponent(ProfilePageComponent);
    fixture.detectChanges();
    return {
        fixture,
        ownProfile,
        editor: TestBed.inject(CanvasEditorService),
        textDraft: TestBed.inject(ProfileEditDraftService),
        ensureLoadedCalls,
        updateProfileCalls,
        saveCanvasCalls,
        navigateCalls,
    };
}

function text(fixture: ComponentFixture<unknown>): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function click(fixture: ComponentFixture<unknown>, testId: string): void {
    (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
        .click();
    fixture.detectChanges();
}

describe('ProfilePageComponent', () => {
    afterEach(() => TestBed.resetTestingModule());

    beforeEach(() => {
        // jsdom implements no `matchMedia`, and PrimeNG's Overlay reads it when it opens.
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

    // ── Back affordance ──────────────────────────────────────────────────────

    it('the back button is present in view state and navigates to /overview', () => {
        const {fixture, navigateCalls} = setup(OWN);
        expect(fixture.nativeElement.querySelector('[data-testid="profile-back"]')).not.toBeNull();

        click(fixture, 'profile-back');
        expect(navigateCalls).toEqual([[['/overview']]]);
    });

    it('the back button is present in edit state too', () => {
        const {fixture, navigateCalls} = setup(OWN);
        click(fixture, 'edit-profile');

        click(fixture, 'profile-back');
        expect(navigateCalls).toEqual([[['/overview']]]);
    });

    it('leaving mid-edit does not prompt, and a dirty bio and canvas draft survive coming back', () => {
        const {fixture, editor, textDraft} = setup(OWN);
        click(fixture, 'edit-profile');

        editor.insert('marquee');
        const bio: HTMLTextAreaElement = fixture.nativeElement.querySelector('[data-testid="bio-field"]');
        bio.value = 'a dirty bio';
        bio.dispatchEvent(new Event('input'));
        fixture.detectChanges();

        expect(editor.dirty()).toBe(true);
        expect(textDraft.dirty()).toBe(true);

        const confirmSpy = vi.spyOn(ConfirmationService.prototype, 'confirm');

        // Leaving the page: the component is destroyed exactly as a route change away from
        // /profile would destroy it. No confirmation is asked.
        fixture.destroy();
        expect(confirmSpy).not.toHaveBeenCalled();

        const revisit = TestBed.createComponent(ProfilePageComponent);
        revisit.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(1);
        expect(textDraft.draft()?.bio).toBe('a dirty bio');
        // The mode itself is not part of the draft; a fresh mount starts in view state.
        expect(revisit.nativeElement.querySelector('[data-testid="edit-profile"]')).not.toBeNull();
    });

    // ── Edit mode ─────────────────────────────────────────────────────────────

    it('Edit reveals the bio field, change affordances and accent/font controls', () => {
        const {fixture} = setup(OWN);
        expect(fixture.nativeElement.querySelector('[data-testid="bio-field"]')).toBeNull();

        click(fixture, 'edit-profile');

        expect(fixture.nativeElement.querySelector('[data-testid="bio-field"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="change-banner"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="change-avatar"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="font-select"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('input[type="color"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="save-profile"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="cancel-edit"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="edit-profile"]')).toBeNull();
    });

    it('renders each font option in its own font stack', () => {
        const {fixture} = setup(OWN);
        click(fixture, 'edit-profile');

        const select = fixture.debugElement.query(By.directive(Select)).componentInstance as Select;
        select.show();
        fixture.detectChanges();

        const rendered = Array.from(
            (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.p-select-option'),
        );
        expect(rendered).toHaveLength(FONT_OPTIONS.length);
        for (const {value, label} of FONT_OPTIONS) {
            const option = rendered.find(el => el.textContent?.trim() === label);
            const span = document.createElement('span');
            span.style.fontFamily = FONT_STACKS[value];
            expect(option?.querySelector('span')?.style.fontFamily).toBe(span.style.fontFamily);
        }
    });

    it('cancelling with nothing changed exits edit mode without asking', () => {
        const {fixture} = setup(OWN);
        click(fixture, 'edit-profile');

        const confirmSpy = vi.spyOn(ConfirmationService.prototype, 'confirm');
        click(fixture, 'cancel-edit');

        expect(confirmSpy).not.toHaveBeenCalled();
        expect(fixture.nativeElement.querySelector('[data-testid="edit-profile"]')).not.toBeNull();
    });

    it('cancelling a dirty draft asks first, and restores what was there on confirm', () => {
        const {fixture, editor, textDraft} = setup(OWN);
        click(fixture, 'edit-profile');

        editor.insert('marquee');
        const bio: HTMLTextAreaElement = fixture.nativeElement.querySelector('[data-testid="bio-field"]');
        bio.value = 'changed bio';
        bio.dispatchEvent(new Event('input'));
        fixture.detectChanges();

        const confirmSpy = vi.spyOn(ConfirmationService.prototype, 'confirm');
        click(fixture, 'cancel-edit');

        expect(confirmSpy).toHaveBeenCalledOnce();
        // Nothing discarded yet: this test never accepts the dialog.
        expect(editor.draft()!.widgets).toHaveLength(1);
        expect(textDraft.draft()?.bio).toBe('changed bio');

        const config = confirmSpy.mock.calls[0][0];
        config.accept?.();
        fixture.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(0);
        expect(textDraft.draft()?.bio).toBe(OWN.bio ?? '');
        expect(fixture.nativeElement.querySelector('[data-testid="edit-profile"]')).not.toBeNull();
    });

    it('Save calls updateProfile and the canvas store save, then cleans the draft while keeping the saved widgets', () => {
        const {fixture, editor, textDraft, updateProfileCalls, saveCanvasCalls} = setup(OWN);
        click(fixture, 'edit-profile');

        editor.insert('marquee');
        const bio: HTMLTextAreaElement = fixture.nativeElement.querySelector('[data-testid="bio-field"]');
        bio.value = 'a saved bio';
        bio.dispatchEvent(new Event('input'));
        fixture.detectChanges();

        click(fixture, 'save-profile');

        expect(updateProfileCalls).toEqual([
            {bio: 'a saved bio', accentColor: OWN.accentColor, font: OWN.font},
        ]);
        expect(saveCanvasCalls).toHaveLength(1);

        // The trap: updateProfile() hands ownProfile a fresh object with the same id, which the
        // mount effect deliberately ignores. Only save()'s own begin() calls may clean this up.
        expect(editor.dirty()).toBe(false);
        expect(textDraft.dirty()).toBe(false);
        expect(editor.draft()!.widgets).toHaveLength(1);
        expect(textDraft.draft()?.bio).toBe('a saved bio');
        expect(fixture.nativeElement.querySelector('[data-testid="edit-profile"]')).not.toBeNull();
    });
});
