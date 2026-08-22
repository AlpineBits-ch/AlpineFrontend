import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';

interface GalleryItem {
    imageId: string;
    alt: string;
}

interface GalleryConfig {
    items: GalleryItem[];
}

function isGalleryConfig(value: unknown): value is GalleryConfig {
    const items = (value as GalleryConfig | null)?.items;
    return Array.isArray(items) && items.every(item => typeof item?.imageId === 'string');
}

@Component({
    selector: 'app-gallery-widget',
    template: `
        @if (items().length > 0) {
            <div class="grid h-full grid-cols-4 gap-1">
                @for (item of items(); track item.imageId) {
                    <img
                        [alt]="item.alt ?? ''"
                        [src]="srcOf(item.imageId)"
                        class="aspect-square w-full rounded-md object-cover"
                    />
                }
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GalleryWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    private api = inject(ProfileCanvasApiService);

    protected readonly items = computed(
        () => parseConfig(this.widget().config, isGalleryConfig)?.items.filter(item => item.imageId) ?? [],
    );

    protected srcOf(imageId: string): string {
        return this.api.imageUrl(imageId);
    }
}
