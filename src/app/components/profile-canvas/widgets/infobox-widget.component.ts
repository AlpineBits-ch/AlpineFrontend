import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface InfoboxRow {
    label: string;
    value: string;
}

interface InfoboxConfig {
    title?: string;
    rows: InfoboxRow[];
}

function isInfoboxConfig(value: unknown): value is InfoboxConfig {
    const rows = (value as InfoboxConfig | null)?.rows;
    return (
        Array.isArray(rows) &&
        rows.every(row => typeof row?.label === 'string' && typeof row?.value === 'string')
    );
}

@Component({
    selector: 'app-infobox-widget',
    template: `
        @if (config(); as box) {
            <div class="flex flex-col gap-2">
                @if (box.title) {
                    <span class="text-[0.625rem] font-semibold uppercase tracking-widest text-text-muted">
                        {{ box.title }}
                    </span>
                }
                <div class="flex flex-col gap-1">
                    @for (row of rows(); track row.label) {
                        <div class="flex items-baseline justify-between gap-2 text-xs">
                            <span class="shrink-0 text-text-muted">{{ row.label }}</span>
                            <span class="min-w-0 truncate text-right text-text-secondary">{{
                                row.value
                            }}</span>
                        </div>
                    }
                </div>
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InfoboxWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isInfoboxConfig));

    protected readonly rows = computed(() => this.config()?.rows.filter(row => row.value.trim()) ?? []);
}
