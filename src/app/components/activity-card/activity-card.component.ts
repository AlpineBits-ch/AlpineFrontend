import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Activity, ACTIVITY_TYPE_ICONS, ACTIVITY_TYPE_KEYS} from '../../models/activity.model';
import {ActivityElapsedPipe} from '../../pipes/activity-elapsed.pipe';
import {ActivityTickerService} from '../../services/activity-ticker.service';
import {BrokenImageService} from '../../services/broken-image.service';

/** The full rich-presence card: art, application name, details, state, party size and a live elapsed timer. */
@Component({
    selector: 'app-activity-card',
    imports: [TranslateModule, ActivityElapsedPipe],
    template: `
        @if (activity(); as a) {
            <div class="flex flex-col gap-2">
                <span class="text-[10px] font-semibold tracking-widest uppercase text-text-muted">
                    {{ typeKey() | translate }}
                </span>

                <div class="flex items-start gap-3">
                    <!-- Art slot: large image with the small image overlaid at its corner. Sized once here. -->
                    <div class="relative shrink-0">
                        @if (largeImage(); as url) {
                            <img
                                [src]="url"
                                [alt]="a.name"
                                (error)="onLargeError(url)"
                                class="w-[60px] h-[60px] rounded-xl object-cover bg-hover"
                            />
                        } @else {
                            <div
                                class="w-[60px] h-[60px] rounded-xl bg-brand/20 flex items-center justify-center select-none"
                            >
                                <span class="text-xl font-bold text-brand-dim">{{ monogram() }}</span>
                            </div>
                        }

                        @if (smallImage(); as url) {
                            <img
                                [src]="url"
                                [alt]="a.assets?.smallText ?? ''"
                                (error)="onSmallError(url)"
                                class="absolute -bottom-1 -right-1 w-5 h-5 rounded-full object-cover ring-2 ring-card bg-hover"
                            />
                        } @else {
                            <span
                                class="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-card ring-2 ring-card flex items-center justify-center"
                            >
                                <i [class]="'pi ' + icon() + ' text-brand-dim'" style="font-size: 9px;"></i>
                            </span>
                        }
                    </div>

                    <div class="flex flex-col min-w-0 gap-0.5 pt-0.5">
                        <span class="text-sm font-semibold text-text-primary truncate">{{ a.name }}</span>

                        @if (a.details) {
                            <span class="text-xs text-text-secondary truncate">{{ a.details }}</span>
                        }

                        <!-- State and party share a line: "In Queue (4 of 5)". The count never stands alone. -->
                        @if (a.state || party()) {
                            <span class="text-xs text-text-secondary truncate">
                                {{ a.state }}
                                @if (party(); as p) {
                                    {{ 'ACTIVITY.PARTY' | translate: p }}
                                }
                            </span>
                        }

                        @if (a.startedAt) {
                            <span class="text-xs text-text-muted tabular-nums">
                                {{
                                    'ACTIVITY.ELAPSED'
                                        | translate: {time: (a.startedAt | activityElapsed: ticker.now())}
                                }}
                            </span>
                        }
                    </div>
                </div>
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivityCardComponent {
    readonly activity = input<Activity | null | undefined>(null);

    protected readonly ticker = inject(ActivityTickerService);
    private readonly brokenImages = inject(BrokenImageService);

    constructor() {
        // Registers this card's timestamp with the one app-wide ticker, and releases it on destroy.
        this.ticker.retain(computed(() => this.activity()?.startedAt ?? null));
    }

    protected readonly typeKey = computed(() => {
        const type = this.activity()?.type;
        return type ? ACTIVITY_TYPE_KEYS[type] : ACTIVITY_TYPE_KEYS.Playing;
    });

    protected readonly icon = computed(() => {
        const type = this.activity()?.type;
        return type ? ACTIVITY_TYPE_ICONS[type] : ACTIVITY_TYPE_ICONS.Playing;
    });

    /** First letter of the game, which is as much identity as a name alone can carry. */
    protected readonly monogram = computed(() => this.activity()?.name?.trim()?.[0]?.toUpperCase() ?? '?');

    protected readonly largeImage = computed(() => this.usable(this.activity()?.assets?.largeImageUrl));
    protected readonly smallImage = computed(() => this.usable(this.activity()?.assets?.smallImageUrl));

    /** The interpolation params for `(4 of 5)`, or null. Both numbers are required. */
    protected readonly party = computed((): {size: number; max: number} | null => {
        const party = this.activity()?.party;
        if (!party?.size || !party.max) return null;
        return {size: party.size, max: party.max};
    });

    protected onLargeError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    protected onSmallError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    private usable(url: string | null | undefined): string | undefined {
        if (!url) return undefined;
        return this.brokenImages.isBroken(url) ? undefined : url;
    }
}
