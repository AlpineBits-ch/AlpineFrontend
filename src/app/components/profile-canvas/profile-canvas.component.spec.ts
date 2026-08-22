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
});
