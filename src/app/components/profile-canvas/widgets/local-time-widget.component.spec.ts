import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {provideTranslateService} from '@ngx-translate/core';
import {LocalTimeWidgetComponent} from './local-time-widget.component';
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
    const fixture = TestBed.createComponent(LocalTimeWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'local-time',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        visibility: 'everyone',
        card: false,
        config,
    };
    fixture.componentRef.setInput('widget', widget);
    fixture.componentRef.setInput('owner', owner());
    fixture.detectChanges();
    return fixture;
}

describe('LocalTimeWidgetComponent', () => {
    it('renders a time for a valid zone', () => {
        const fixture = render({timeZone: 'Europe/Zurich'});
        expect(fixture.nativeElement.textContent).toMatch(/\d{1,2}:\d{2}/);
    });

    it('renders nothing for a zone the platform rejects', () => {
        const fixture = render({timeZone: 'Not/AZone'});
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });

    it('renders nothing for a malformed config', () => {
        const fixture = render({});
        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });
});
