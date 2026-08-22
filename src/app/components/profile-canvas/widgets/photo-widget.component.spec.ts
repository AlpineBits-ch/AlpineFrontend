import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {PhotoWidgetComponent} from './photo-widget.component';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

class FakeApi {
    imageUrl(imageId: string): string {
        return `https://cdn.test/${imageId}`;
    }
}

function owner(): ProfileDto {
    return {
        id: 'p1',
        userId: 'u1',
        userName: 'Marrow',
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
    TestBed.configureTestingModule({
        providers: [{provide: ProfileCanvasApiService, useValue: new FakeApi()}],
    });
    const fixture = TestBed.createComponent(PhotoWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'photo',
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

describe('PhotoWidgetComponent', () => {
    it('builds the src from the image id', () => {
        const fixture = render({imageId: 'img1', alt: 'a hill'});
        const img: HTMLImageElement = fixture.nativeElement.querySelector('img');
        expect(img.getAttribute('src')).toBe('https://cdn.test/img1');
        expect(img.getAttribute('alt')).toBe('a hill');
    });

    it('renders nothing without an image id', () => {
        const fixture = render({alt: 'a hill'});
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
    });

    it('draws the caption when there is one', () => {
        const fixture = render({imageId: 'img1', alt: 'a hill', caption: 'Kyoto'});
        expect(fixture.nativeElement.textContent).toContain('Kyoto');
    });
});
