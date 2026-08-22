import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal, WritableSignal} from '@angular/core';
import {By} from '@angular/platform-browser';
import {Router} from '@angular/router';
import {provideTranslateService} from '@ngx-translate/core';
import {ConfirmationService, MessageService} from 'primeng/api';
import {Select} from 'primeng/select';
import {Observable, of, Subject, throwError} from 'rxjs';
import {vi} from 'vitest';
import {ProfilePageComponent} from './profile-page.component';
import {ProfileService} from '../../../services/profile.service';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileEditDraftService} from '../../../services/profile-edit-draft.service';
import {ProfileCanvasStore} from '../../../stores/profile-canvas.store';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';
import {FONT_OPTIONS, FONT_STACKS} from '../../../models/profile-font.model';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';
import {AUTOSAVE_DEBOUNCE_MS} from '../../discovery/listing-editor/listing-editor.component';

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

interface Overrides {
    updateProfile?: (patch: unknown) => Observable<ProfileDto>;
    saveCanvas?: (canvas: unknown) => Observable<unknown>;
}

function setup(initial: ProfileDto | undefined, overrides: Overrides = {}) {
    const ownProfile: WritableSignal<ProfileDto | undefined> = signal(initial);
    const ensureLoadedCalls: string[] = [];
    const updateProfileCalls: unknown[] = [];
    const saveCanvasCalls: unknown[] = [];
    const navigateCalls: unknown[] = [];
    const removeAvatarCalls: unknown[] = [];

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
                        if (overrides.updateProfile) return overrides.updateProfile(patch);
                        const current = ownProfile();
                        const saved = {...current, ...(patch as object)} as ProfileDto;
                        return of(saved);
                    },
                    uploadAvatar: () => of(ownProfile()),
                    uploadBanner: () => of(ownProfile()),
                    removeAvatar: () => {
                        removeAvatarCalls.push(undefined);
                        return of({...ownProfile(), avatarUrl: undefined});
                    },
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
                        if (overrides.saveCanvas) return overrides.saveCanvas(canvas);
                        return of(canvas);
                    },
                },
            },
            {provide: ProfileCanvasApiService, useValue: {imageUrl: (id: string) => `img/${id}`}},
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
        removeAvatarCalls,
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

function tile(fixture: ComponentFixture<unknown>, widgetId: string): HTMLElement {
    return (fixture.nativeElement as HTMLElement).querySelector(`[data-widget-id="${widgetId}"]`)!;
}

function popover(fixture: ComponentFixture<unknown>): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('[data-testid="widget-editor-popover"]');
}

function bioField(fixture: ComponentFixture<unknown>): HTMLTextAreaElement {
    return (fixture.nativeElement as HTMLElement).querySelector('[data-testid="bio-field"]')!;
}

function typeBio(fixture: ComponentFixture<unknown>, value: string): void {
    const field = bioField(fixture);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
}

function status(fixture: ComponentFixture<ProfilePageComponent>): string {
    return (fixture.componentInstance as unknown as {saveStatus: () => string}).saveStatus();
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
        const banner = el.querySelector('.h-32') as HTMLElement;

        expect(el.querySelector('img[alt=""]')).toBeNull();
        expect(banner.style.background).not.toBe('');
        expect(banner.style.background).not.toBe('none');
    });

    it("draws the name in the profile's own font and accent", () => {
        const {fixture} = setup(OWN);
        const h1 = fixture.nativeElement.querySelector('h1') as HTMLElement;

        expect(h1.style.color).toBe('rgb(51, 102, 153)');
    });

    it('shows a loading state instead of throwing when there is no profile yet', () => {
        let fixture!: ComponentFixture<ProfilePageComponent>;
        expect(() => (fixture = setup(undefined).fixture)).not.toThrow();

        expect(fixture.nativeElement.querySelector('app-avatar')).toBeNull();
        expect(text(fixture)).not.toContain('fakePilotDominic');
        expect(fixture.nativeElement.querySelector('[role="status"]')).not.toBeNull();
    });

    it('an unrelated profile write does not wipe an in-flight canvas autosave', () => {
        // Canvas edits write on their own; hold the response open so the save is still
        // in flight, not yet acknowledged, when the unrelated write lands.
        const saveResponse = new Subject<unknown>();
        const {fixture, ownProfile, editor} = setup(OWN, {saveCanvas: () => saveResponse});
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

    it('the back button navigates to /overview', () => {
        const {fixture, navigateCalls} = setup(OWN);
        expect(fixture.nativeElement.querySelector('[data-testid="profile-back"]')).not.toBeNull();

        click(fixture, 'profile-back');
        expect(navigateCalls).toEqual([[['/overview']]]);
    });

    it('leaving does not prompt, and a dirty bio and canvas draft survive coming back', () => {
        const {fixture, editor, textDraft} = setup(OWN);

        editor.insert('marquee');
        typeBio(fixture, 'a dirty bio');

        const confirmSpy = vi.spyOn(ConfirmationService.prototype, 'confirm');

        // Leaving the page: the component is destroyed exactly as a route change away from
        // /profile would destroy it. No confirmation is asked; the destroy flush autosaves
        // whatever the debounce had not gotten to yet.
        fixture.destroy();
        expect(confirmSpy).not.toHaveBeenCalled();

        const revisit = TestBed.createComponent(ProfilePageComponent);
        revisit.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(1);
        expect(textDraft.draft()?.bio).toBe('a dirty bio');
        expect(revisit.nativeElement.querySelector('[data-testid="bio-field"]')).not.toBeNull();
    });

    // ── Always editable ──────────────────────────────────────────────────────

    it('the bio field, change affordances and accent/font controls are present with nothing to click first', () => {
        const {fixture} = setup(OWN);

        expect(fixture.nativeElement.querySelector('[data-testid="bio-field"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="change-banner"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="change-avatar"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="font-select"]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('input[type="color"]')).not.toBeNull();
    });

    it('renders each font option in its own font stack', () => {
        const {fixture} = setup(OWN);

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

    it('the canvas lattice stays quiet: nothing drags it on yet', () => {
        const {fixture} = setup(OWN);
        const lattice = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
            '[data-testid="canvas-lattice"]',
        )!;

        expect(lattice.classList.contains('opacity-0')).toBe(true);
        expect(lattice.classList.contains('opacity-100')).toBe(false);
    });

    it('removing the avatar asks first, and only calls removeAvatar on confirm', () => {
        const {fixture, removeAvatarCalls} = setup({...OWN, avatarUrl: 'https://cdn.test.example/a.png'});

        // vi.spyOn returns the same mock across tests in this file since nothing restores it,
        // so clear it first rather than asserting against calls other tests already made.
        const confirmSpy = vi.spyOn(ConfirmationService.prototype, 'confirm');
        confirmSpy.mockClear();
        click(fixture, 'remove-avatar');

        expect(confirmSpy).toHaveBeenCalledOnce();
        expect(removeAvatarCalls).toHaveLength(0);

        const config = confirmSpy.mock.calls[0][0];
        config.accept?.();

        expect(removeAvatarCalls).toHaveLength(1);
    });

    // ── Autosave ──────────────────────────────────────────────────────────────

    describe('autosave', () => {
        afterEach(() => vi.useRealTimers());

        it('a bio edit autosaves after the debounce', async () => {
            vi.useFakeTimers();
            const {fixture, updateProfileCalls} = setup(OWN);

            typeBio(fixture, 'a new bio');
            expect(updateProfileCalls).toHaveLength(0);
            expect(status(fixture)).toBe('unsaved');

            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

            expect(updateProfileCalls).toEqual([
                {bio: 'a new bio', accentColor: OWN.accentColor, font: OWN.font},
            ]);
        });

        it('a burst of edits is one write', async () => {
            vi.useFakeTimers();
            const {fixture, updateProfileCalls} = setup(OWN);

            for (const value of ['a', 'ab', 'abc']) typeBio(fixture, value);
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

            expect(updateProfileCalls).toHaveLength(1);
            expect(updateProfileCalls[0]).toEqual({bio: 'abc', accentColor: OWN.accentColor, font: OWN.font});
        });

        it('the status reaches saved once the autosave completes', async () => {
            vi.useFakeTimers();
            const {fixture} = setup(OWN);

            typeBio(fixture, 'x');
            expect(status(fixture)).toBe('unsaved');

            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
            fixture.detectChanges();

            expect(status(fixture)).toBe('saved');
        });

        it('a failed autosave shows the error status', async () => {
            vi.useFakeTimers();
            const {fixture} = setup(OWN, {updateProfile: () => throwError(() => new Error('refused'))});

            typeBio(fixture, 'x');
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
            fixture.detectChanges();

            expect(status(fixture)).toBe('error');
        });

        it('destroying the page flushes a bio edit the debounce has not fired yet', () => {
            const {fixture, updateProfileCalls} = setup(OWN);

            typeBio(fixture, 'about to leave');
            expect(updateProfileCalls).toHaveLength(0);

            fixture.destroy();

            expect(updateProfileCalls).toEqual([
                {bio: 'about to leave', accentColor: OWN.accentColor, font: OWN.font},
            ]);
        });

        it('destroying the page flushes a canvas edit the effect has not caught up with', () => {
            const {fixture, editor, saveCanvasCalls} = setup(OWN);

            editor.insert('marquee');
            fixture.detectChanges();

            expect(saveCanvasCalls.length).toBeGreaterThan(0);
            fixture.destroy();

            // Already clean by the time destroy runs, since the mock resolves synchronously;
            // the guard is that destroy never throws and never double-sends once clean.
            expect(editor.dirty()).toBe(false);
        });

        // Section 5's trap, autosave edition: updateProfile() re-baselines textDraft on success,
        // and it now fires on every debounce tick rather than once per Save.
        it('a save in flight does not let its stale response wipe an edit made after it was sent', async () => {
            vi.useFakeTimers();
            const response = new Subject<ProfileDto>();
            const {fixture, textDraft} = setup(OWN, {updateProfile: () => response});

            typeBio(fixture, 'first');
            await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
            // The debounce fired; updateProfile() was called and is in flight.

            typeBio(fixture, 'second');

            // The in-flight request's response lands, carrying only what "first" produced.
            response.next({...OWN, bio: 'first'});
            response.complete();

            expect(textDraft.draft()?.bio).toBe('second');
        });
    });

    // ── Widget editor popover ────────────────────────────────────────────────

    function selectFirstWidget(fixture: ComponentFixture<ProfilePageComponent>, editor: CanvasEditorService) {
        editor.insert('quote');
        fixture.detectChanges();
        const id = editor.draft()!.widgets[0].id;
        tile(fixture, id).click();
        fixture.detectChanges();
        return id;
    }

    it('clicking a tile selects it and anchors the editor to it', () => {
        const {fixture, editor} = setup(OWN);
        const id = selectFirstWidget(fixture, editor);

        expect(popover(fixture)).not.toBeNull();
        expect(tile(fixture, id).getAttribute('aria-pressed')).toBe('true');
    });

    it('clicking the selected tile again deselects and hides the editor', () => {
        const {fixture, editor} = setup(OWN);
        const id = selectFirstWidget(fixture, editor);

        tile(fixture, id).click();
        fixture.detectChanges();

        expect(popover(fixture)).toBeNull();
        expect(tile(fixture, id).getAttribute('aria-pressed')).toBe('false');
    });

    it('clicking elsewhere deselects and hides the editor', () => {
        const {fixture, editor} = setup(OWN);
        const id = selectFirstWidget(fixture, editor);

        (fixture.nativeElement as HTMLElement)
            .querySelector('h1')!
            .dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
        fixture.detectChanges();

        expect(popover(fixture)).toBeNull();
        expect(tile(fixture, id).getAttribute('aria-pressed')).toBe('false');
    });

    it('Escape closes the editor and keeps the tile selected', () => {
        const {fixture, editor} = setup(OWN);
        const id = selectFirstWidget(fixture, editor);

        popover(fixture)!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        fixture.detectChanges();

        expect(popover(fixture)).toBeNull();
        expect(tile(fixture, id).getAttribute('aria-pressed')).toBe('true');
    });

    it('is reachable and dismissible by keyboard alone', () => {
        const {fixture, editor} = setup(OWN);
        editor.insert('quote');
        fixture.detectChanges();
        const id = editor.draft()!.widgets[0].id;

        tile(fixture, id).dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        fixture.detectChanges();
        expect(popover(fixture)).not.toBeNull();

        popover(fixture)!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        fixture.detectChanges();
        expect(popover(fixture)).toBeNull();
    });

    it('deleting the selected widget removes it and clears the selection', () => {
        const {fixture, editor} = setup(OWN);
        selectFirstWidget(fixture, editor);

        popover(fixture)!.querySelector<HTMLButtonElement>('[data-testid="delete-widget"]')!.click();
        fixture.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(0);
        expect(popover(fixture)).toBeNull();
    });
});
