import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface CurrentlyRow {
    verb: string;
    text: string;
}

interface CurrentlyConfig {
    rows: CurrentlyRow[];
}

function isCurrentlyConfig(value: unknown): value is CurrentlyConfig {
    const rows = (value as CurrentlyConfig | null)?.rows;
    return (
        Array.isArray(rows) &&
        rows.every(row => typeof row?.verb === 'string' && typeof row?.text === 'string')
    );
}

@Component({
    selector: 'app-currently-widget',
    template: `
        @if (config()) {
            <div class="flex flex-col gap-2">
                @for (row of rows(); track row.verb + row.text) {
                    <div class="flex items-center gap-2">
                        <span class="shrink-0 rounded-full bg-hover px-2 py-0.5 text-xs text-text-secondary">
                            {{ row.verb }}
                        </span>
                        <span class="min-w-0 truncate text-xs text-text-secondary">{{ row.text }}</span>
                    </div>
                }
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CurrentlyWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isCurrentlyConfig));

    /** An unanswered row reads as a blank, so it is left out rather than drawn empty. */
    protected readonly rows = computed(() => this.config()?.rows.filter(row => row.text.trim()) ?? []);
}
