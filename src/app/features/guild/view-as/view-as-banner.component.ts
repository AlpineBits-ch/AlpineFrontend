import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ViewAsService} from './view-as.service';

@Component({
    selector: 'app-view-as-banner',
    imports: [TranslateModule],
    templateUrl: './view-as-banner.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewAsBannerComponent {
    readonly guildId = input.required<string>();
    readonly visibleCount = input(0);
    readonly totalCount = input(0);

    private viewAs = inject(ViewAsService);

    protected readonly subject = computed(() => this.viewAs.subject(this.guildId())());

    exit(): void {
        this.viewAs.exit(this.guildId());
    }
}
