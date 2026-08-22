import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {GalleryWidgetComponent} from './gallery-widget.component';
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
    const fixture = TestBed.createComponent(GalleryWidgetComponent);
    const widget: CanvasWidgetDto = {
        id: 'a',
        type: 'gallery',
        x: 0,
        y: 0,
        w: 4,
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

describe('GalleryWidgetComponent', () => {
    it('builds every src through the api service', () => {
        const fixture = render({
            items: [
                {imageId: 'img1', alt: 'a hill'},
                {imageId: 'img2', alt: 'a lake'},
            ],
        });
        const imgs: HTMLImageElement[] = Array.from(fixture.nativeElement.querySelectorAll('img'));
        expect(imgs.map(img => img.getAttribute('src'))).toEqual([
            'https://cdn.test/img1',
            'https://cdn.test/img2',
        ]);
    });

    it('filters out an item with no image id', () => {
        const fixture = render({
            items: [
                {imageId: '', alt: 'a hill'},
                {imageId: 'img2', alt: 'a lake'},
            ],
        });
        const imgs: HTMLImageElement[] = Array.from(fixture.nativeElement.querySelectorAll('img'));
        expect(imgs).toHaveLength(1);
        expect(imgs[0].getAttribute('src')).toBe('https://cdn.test/img2');
    });

    it('renders nothing for a malformed config', () => {
        const fixture = render({items: 'nope'});
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
    });

    it('gives every image an alt attribute, even without one in the config', () => {
        const fixture = render({items: [{imageId: 'img1'}]});
        const img: HTMLImageElement = fixture.nativeElement.querySelector('img');
        expect(img.hasAttribute('alt')).toBe(true);
        expect(img.getAttribute('alt')).toBe('');
    });
});
