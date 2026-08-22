import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {of} from 'rxjs';
import {provideTranslateService} from '@ngx-translate/core';
import {CanvasEditorComponent} from './canvas-editor.component';
import {CanvasEditorService} from '../../../../../../services/canvas-editor.service';
import {ProfileCanvasStore} from '../../../../../../stores/profile-canvas.store';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileCanvasApiService} from '../../../../../../services/profile-canvas-api.service';
import {emptyCanvas} from '../../../../../../models/profile-canvas';
import {WIDGET_REGISTRY} from '../../../../../../components/profile-canvas/widget-registry';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../../../../dtos/response/profile.dto';
import {ConfirmationService, MessageService} from 'primeng/api';
import {signal} from '@angular/core';

function profile(): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'Nova',
        bio: undefined,
        avatarUrl: undefined,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date(),
        updatedAt: new Date(),
        onlineStatus: OnlineStatus.Online,
    };
}

class FakeCanvasApi {
    imageUrl(id: string): string {
        return `https://cdn.test/${id}`;
    }
}

function setup(initial: ProfileDto = profile()) {
    const saved: unknown[] = [];
    const ownProfile = signal<ProfileDto | undefined>(initial);
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            MessageService,
            ConfirmationService,
            {provide: ProfileService, useValue: {ownProfile}},
            {provide: ProfileCanvasApiService, useValue: new FakeCanvasApi()},
            {
                provide: ProfileCanvasStore,
                useValue: {
                    canvasFor: () => emptyCanvas('p1'),
                    ensureLoaded: () => undefined,
                    saving: signal(false),
                    save: (canvas: unknown) => {
                        saved.push(canvas);
                        return of(canvas);
                    },
                },
            },
        ],
    });
    const fixture = TestBed.createComponent(CanvasEditorComponent);
    fixture.detectChanges();
    return {fixture, saved, editor: TestBed.inject(CanvasEditorService), ownProfile};
}

describe('CanvasEditorComponent', () => {
    it('offers every registered widget type in the insert menu', () => {
        const {fixture} = setup();
        const buttons = fixture.nativeElement.querySelectorAll('[data-testid="insert-widget"]');
        expect(buttons.length).toBeGreaterThanOrEqual(9);
    });

    it('inserting a widget marks the editor dirty', () => {
        const {fixture, editor} = setup();
        editor.insert('quote');
        fixture.detectChanges();
        expect(editor.dirty()).toBe(true);
    });

    it('save hands the draft to the store', () => {
        const {fixture, saved, editor} = setup();
        editor.insert('quote');
        fixture.detectChanges();

        fixture.nativeElement.querySelector('[data-testid="save-canvas"]').click();
        expect(saved).toHaveLength(1);
    });

    it('save is disabled while the draft is clean', () => {
        const {fixture} = setup();
        const save: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="save-canvas"]');
        expect(save.disabled).toBe(true);
    });

    it('list rows are buttons with move and remove as siblings, never nested', () => {
        const {fixture, editor} = setup();
        editor.insert('quote');
        editor.insert('marquee');
        fixture.detectChanges();

        const rows: HTMLLIElement[] = [
            ...fixture.nativeElement.querySelectorAll('[data-testid="widget-row"]'),
        ];
        expect(rows.length).toBe(2);
        for (const row of rows) {
            const rowButtons = [...row.querySelectorAll('button')];
            expect(rowButtons.length).toBeGreaterThan(1);
            for (const button of rowButtons) {
                expect(button.querySelector('button')).toBeNull();
            }
        }
    });

    it('arrow keys move the selection between rows', () => {
        const {fixture, editor} = setup();
        editor.insert('quote');
        editor.insert('marquee');
        fixture.detectChanges();

        const widgets = editor.draft()!.widgets;
        const first: HTMLButtonElement = fixture.nativeElement.querySelector(
            `[data-testid="widget-select-${widgets[0].id}"]`,
        );
        first.click();
        fixture.detectChanges();

        first.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
        fixture.detectChanges();

        const component = fixture.componentInstance as unknown as {selectedId: () => string | null};
        expect(component.selectedId()).toBe(widgets[1].id);
        // Order in the draft is untouched by a plain arrow key.
        expect(editor.draft()!.widgets.map(w => w.id)).toEqual(widgets.map(w => w.id));
    });

    it('a modified arrow key moves the selected widget instead of the selection', () => {
        const {fixture, editor} = setup();
        editor.insert('quote');
        editor.insert('marquee');
        fixture.detectChanges();

        const widgets = editor.draft()!.widgets;
        const first: HTMLButtonElement = fixture.nativeElement.querySelector(
            `[data-testid="widget-select-${widgets[0].id}"]`,
        );
        first.click();
        fixture.detectChanges();

        first.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', shiftKey: true, bubbles: true}));
        fixture.detectChanges();

        expect(editor.draft()!.widgets.map(w => w.id)).toEqual([widgets[1].id, widgets[0].id]);
    });

    it('discarding a dirty draft asks for confirmation first', () => {
        const {fixture, editor} = setup();
        editor.insert('quote');
        fixture.detectChanges();

        const discard: HTMLButtonElement = fixture.nativeElement.querySelector(
            '[data-testid="discard-canvas"]',
        );
        discard.click();
        fixture.detectChanges();

        // The service call only happens after PrimeNG's confirm dialog accepts, which this test
        // never does, so the widget the user just inserted must still be there.
        expect(editor.draft()!.widgets).toHaveLength(1);
    });

    it('does not discard an in-progress draft when the profile object changes but its id does not', () => {
        const {fixture, editor, ownProfile} = setup();
        editor.insert('quote');
        fixture.detectChanges();
        expect(editor.dirty()).toBe(true);

        // Same id, a fresh object: exactly what ProfileService.ownProfile hands out after
        // updateProfile() / uploadAvatar() / uploadBanner() / setSelfStatus().
        ownProfile.set({...profile(), bio: 'a new bio'});
        fixture.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(1);
        expect(editor.dirty()).toBe(true);
    });

    it('re-begins the draft when the profile id actually changes', () => {
        const {fixture, editor, ownProfile} = setup();
        editor.insert('quote');
        fixture.detectChanges();
        expect(editor.draft()!.widgets).toHaveLength(1);

        ownProfile.set({...profile(), id: 'p2'});
        fixture.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(0);
        expect(editor.dirty()).toBe(false);
    });

    it('inserts every registered widget type and renders it without throwing', () => {
        const {fixture, editor} = setup();

        for (const definition of WIDGET_REGISTRY) {
            expect(() => editor.insert(definition.type)).not.toThrow();
        }
        expect(() => fixture.detectChanges()).not.toThrow();

        const cells = fixture.nativeElement.querySelectorAll('app-profile-canvas > div > div');
        // photo's default config has an empty imageId and renders blank by design; every other
        // type still gets a grid cell, so the cell count tracks the widget count regardless.
        expect(cells.length).toBe(WIDGET_REGISTRY.length);
        expect(editor.draft()!.widgets).toHaveLength(WIDGET_REGISTRY.length);
    });
});
