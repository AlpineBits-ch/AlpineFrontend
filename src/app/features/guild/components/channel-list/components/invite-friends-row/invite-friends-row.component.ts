import {ChangeDetectionStrategy, Component, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

/**
 * The empty seat under your own name in a voice channel you just walked into alone.
 *
 * <p>It is drawn as a participant row because that is what it is standing in for - the person who
 * is not there yet - which is also why it sits in the roster rather than in the channel header.
 * Whether it is showing at all is {@link InviteNudgeService}'s answer, not this component's.</p>
 */
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
