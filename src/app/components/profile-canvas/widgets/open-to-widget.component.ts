import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface OpenToItem {
    label: string;
    state: 'yes' | 'no';
}

interface OpenToConfig {
    items: OpenToItem[];
}

function isOpenToConfig(value: unknown): value is OpenToConfig {
    const items = (value as OpenToConfig | null)?.items;
    return (
        Array.isArray(items) &&
        items.every(item => typeof item?.label === 'string' && (item.state === 'yes' || item.state === 'no'))
    );
}

@Component({
    selector: 'app-open-to-widget',
    template: `
        @if (config(); as open) {
            <div class="flex flex-wrap content-start gap-1.5">
                @for (item of open.items; track item.label) {
                    <span
                        [class.bg-online/15]="item.state === 'yes'"
                        [class.text-online]="item.state === 'yes'"
                        [class.bg-hover]="item.state === 'no'"
                        [class.text-text-muted]="item.state === 'no'"
                        [class.line-through]="item.state === 'no'"
                        class="rounded-full px-2 py-0.5 text-xs"
                    >
                        {{ item.label }}
                    </span>
                }
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpenToWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isOpenToConfig));
}
