import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {CurrentlyWidgetComponent} from './currently-widget.component';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

function owner(): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'hex',
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

function render(config: unknown) {
    TestBed.configureTestingModule({providers: [provideTranslateService()]});
    const fixture = TestBed.createComponent(CurrentlyWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'currently',
        x: 0,
        y: 0,
        w: 2,
        h: 2,
        visibility: 'everyone',
        card: false,
        config,
    };
    fixture.componentRef.setInput('widget', widget);
    fixture.componentRef.setInput('owner', owner());
    fixture.detectChanges();
    return fixture;
}

describe('CurrentlyWidgetComponent', () => {
    it('draws a row per entry', () => {
        const fixture = render({
            rows: [
                {verb: 'reading', text: 'Piranesi'},
                {verb: 'building', text: 'a raytracer'},
            ],
        });
        expect(fixture.nativeElement.textContent).toContain('Piranesi');
        expect(fixture.nativeElement.textContent).toContain('a raytracer');
    });

    it('skips a row with no text', () => {
        const fixture = render({rows: [{verb: 'reading', text: ''}]});
        expect(fixture.nativeElement.textContent).not.toContain('reading');
    });

    it('renders nothing for a malformed config', () => {
        const fixture = render({rows: 'nope'});
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });
});
