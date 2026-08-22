import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {ProfileCanvasComponent} from './profile-canvas.component';
import {CanvasWidgetDto, ProfileCanvasDto} from '../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../dtos/response/profile.dto';

function owner(): ProfileDto {
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

function widget(id: string, over: Partial<CanvasWidgetDto> = {}): CanvasWidgetDto {
    return {
        id,
        type: 'quote',
        x: 0,
        y: 0,
        w: 2,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {text: 'a line'},
        ...over,
    };
}

function canvasOf(widgets: CanvasWidgetDto[]): ProfileCanvasDto {
    return {
        profileId: 'p1',
        updatedAt: '',
        version: 1,
        theme: {accent: null, backdrop: null},
        widgets,
    };
}

function render(canvas: ProfileCanvasDto, inputs: Record<string, unknown> = {}) {
    TestBed.configureTestingModule({providers: [provideTranslateService()]});
    const fixture = TestBed.createComponent(ProfileCanvasComponent);
    fixture.componentRef.setInput('canvas', canvas);
    fixture.componentRef.setInput('owner', owner());
    for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    return fixture;
}

describe('ProfileCanvasComponent', () => {
    it('draws a widget it knows', () => {
        const fixture = render(canvasOf([widget('a')]));
        expect(fixture.nativeElement.textContent).toContain('a line');
    });

    it('skips a type it does not know instead of throwing', () => {
        const fixture = render(canvasOf([widget('a', {type: 'from-the-future'})]));
        expect(fixture.nativeElement.querySelectorAll('[style*="grid-column"]')).toHaveLength(0);
    });

    it('skips an unknown type sitting between two known ones', () => {
        const fixture = render(
            canvasOf([
                widget('a', {config: {text: 'first'}}),
                widget('b', {type: 'from-the-future'}),
                widget('c', {config: {text: 'third'}}),
            ]),
        );
        expect(fixture.nativeElement.textContent).toContain('first');
        expect(fixture.nativeElement.textContent).toContain('third');
        expect(fixture.nativeElement.querySelectorAll('[style*="grid-column"]')).toHaveLength(2);
    });

    it('renders nothing for a malformed config', () => {
        const fixture = render(canvasOf([widget('a', {config: {text: 42}})]));
        expect(fixture.nativeElement.textContent).not.toContain('42');
    });

    it('cardOnly draws only the hover-preview widgets', () => {
        const fixture = render(
            canvasOf([
                widget('a', {card: true, config: {text: 'shown'}}),
                widget('b', {config: {text: 'hidden'}}),
            ]),
            {cardOnly: true, columns: 1},
        );
        expect(fixture.nativeElement.textContent).toContain('shown');
        expect(fixture.nativeElement.textContent).not.toContain('hidden');
    });

    function tile(fixture: ReturnType<typeof render>, id: string): HTMLElement {
        return fixture.nativeElement.querySelector(`[data-widget-id="${id}"]`)!;
    }

    describe('selection', () => {
        it('is inert by default, even with a selectedId set', () => {
            const fixture = render(canvasOf([widget('a')]), {selectedId: 'a'});
            const el = tile(fixture, 'a');

            expect(el.getAttribute('role')).toBeNull();
            expect(el.getAttribute('tabindex')).toBeNull();
        });

        it('makes a real widget a focusable, clickable button when selectable', () => {
            const fixture = render(canvasOf([widget('a')]), {selectable: true});
            const el = tile(fixture, 'a');

            expect(el.getAttribute('role')).toBe('button');
            expect(el.getAttribute('tabindex')).toBe('0');
        });

        it('never makes a spacer selectable: it has nothing a properties panel could edit', () => {
            const fixture = render(canvasOf([widget('a', {type: 'spacer', w: 1, h: 1})]), {
                selectable: true,
            });
            const el = tile(fixture, 'a');

            expect(el.getAttribute('role')).toBeNull();
            expect(el.getAttribute('tabindex')).toBeNull();
        });

        it('keeps a fieldless real widget (mutuals) selectable, unlike a spacer', () => {
            const fixture = render(canvasOf([widget('a', {type: 'mutuals', w: 2, h: 1})]), {
                selectable: true,
            });
            expect(tile(fixture, 'a').getAttribute('role')).toBe('button');
        });

        it('emits widgetSelected with the id and element on click', () => {
            const fixture = render(canvasOf([widget('a')]), {selectable: true});
            let emitted: {id: string; element: HTMLElement} | undefined;
            fixture.componentInstance.widgetSelected.subscribe(v => (emitted = v));

            tile(fixture, 'a').click();

            expect(emitted?.id).toBe('a');
            expect(emitted?.element).toBe(tile(fixture, 'a'));
        });

        it('emits widgetSelected on Enter and Space, not on other keys', () => {
            const fixture = render(canvasOf([widget('a')]), {selectable: true});
            const emitted: string[] = [];
            fixture.componentInstance.widgetSelected.subscribe(v => emitted.push(v.id));

            tile(fixture, 'a').dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true}));
            tile(fixture, 'a').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            tile(fixture, 'a').dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true}));

            expect(emitted).toEqual(['a', 'a']);
        });

        it('never emits for a spacer, click or keyboard', () => {
            const fixture = render(canvasOf([widget('a', {type: 'spacer', w: 1, h: 1})]), {
                selectable: true,
            });
            const emitted: string[] = [];
            fixture.componentInstance.widgetSelected.subscribe(v => emitted.push(v.id));

            tile(fixture, 'a').click();
            tile(fixture, 'a').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));

            expect(emitted).toEqual([]);
        });

        it('marks the selected tile distinctly from the rest', () => {
            const fixture = render(canvasOf([widget('a'), widget('b')]), {
                selectable: true,
                selectedId: 'a',
            });

            expect(tile(fixture, 'a').getAttribute('aria-pressed')).toBe('true');
            expect(tile(fixture, 'b').getAttribute('aria-pressed')).toBe('false');
        });
    });
});
