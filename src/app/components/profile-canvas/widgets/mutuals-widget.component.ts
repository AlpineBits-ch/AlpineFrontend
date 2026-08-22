import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {AppAvatarComponent} from '../../avatar/avatar.component';

const SHOWN = 4;

@Component({
    selector: 'app-mutuals-widget',
    imports: [TranslateModule, AppAvatarComponent],
    template: `
        @if (shown().length > 0) {
            <div class="flex h-full flex-col justify-center gap-2">
                <div class="flex items-center">
                    @for (friend of shown(); track friend.userId) {
                        <div class="-ml-2 first:ml-0 ring-2 ring-card rounded-full">
                            <app-avatar
                                [label]="initialOf(friend.userName)"
                                [userId]="friend.userId"
                                size="normal"
                            />
                        </div>
                    }
                    @if (extra() > 0) {
                        <span class="ml-2 text-xs text-text-muted">+{{ extra() }}</span>
                    }
                </div>
                <span class="text-xs text-text-muted">{{ countLabel() | translate: {count: total()} }}</span>
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MutualsWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    /** Absent means the viewer may not see them, which is not the same as none. Both draw nothing. */
    protected readonly total = computed(() => this.owner().mutualFriends?.length ?? 0);

    protected readonly shown = computed(() => this.owner().mutualFriends?.slice(0, SHOWN) ?? []);

    protected readonly extra = computed(() => Math.max(0, this.total() - SHOWN));

    protected readonly countLabel = computed(() =>
        this.total() === 1 ? 'PROFILE.CANVAS.MUTUALS_COUNT_ONE' : 'PROFILE.CANVAS.MUTUALS_COUNT',
    );

    protected initialOf(name: string): string {
        return name.charAt(0).toUpperCase();
    }
}
