import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';

interface PhotoConfig {
    imageId: string;
    alt: string;
    caption?: string;
}

function isPhotoConfig(value: unknown): value is PhotoConfig {
    const config = value as PhotoConfig | null;
    return !!config && typeof config.imageId === 'string' && config.imageId.length > 0;
}

@Component({
    selector: 'app-photo-widget',
    template: `
        @if (config(); as photo) {
            <figure class="flex h-full flex-col gap-1.5">
                <img
                    [alt]="photo.alt ?? ''"
                    [src]="src()"
                    class="min-h-0 w-full flex-1 rounded-lg object-cover"
                />
                @if (photo.caption) {
                    <figcaption class="shrink-0 truncate text-xs text-text-muted">
                        {{ photo.caption }}
                    </figcaption>
                }
            </figure>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    private api = inject(ProfileCanvasApiService);

    protected readonly config = computed(() => parseConfig(this.widget().config, isPhotoConfig));

    protected readonly src = computed(() => {
        const imageId = this.config()?.imageId;
        return imageId ? this.api.imageUrl(imageId) : '';
    });
}
