import {ChangeDetectionStrategy, Component, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

/** The empty seat under your own name in a voice channel you just walked into alone; drawn as a participant row since that's what it stands in for. Whether it shows at all is {@link InviteNudgeService}'s answer, not this component's. */
@Component({
    selector: 'app-invite-friends-row',
    host: {class: 'contents'},
    standalone: true,
    imports: [TranslateModule],
    templateUrl: './invite-friends-row.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InviteFriendsRowComponent {
    /** Carries the event so the host can anchor the panel to this row. */
    readonly open = output<MouseEvent>();
}
