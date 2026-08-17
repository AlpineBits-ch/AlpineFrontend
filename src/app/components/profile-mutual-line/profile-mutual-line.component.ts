import {ChangeDetectionStrategy, Component, computed, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AppAvatarComponent} from '../avatar/avatar.component';
import {ProfileDto} from '../../dtos/response/profile.dto';

/** How many friend avatars the stack shows before it is just a count. */
const STACK_SIZE = 3;

/**
 * The one-line mutuals summary under a name.
 *
 * A gated field the viewer may not see is absent from the payload entirely, so every read here is
 * optional and an empty half draws nothing rather than "0 mutual friends".
 */
@Component({
    selector: 'app-profile-mutual-line',
    imports: [TranslateModule, AppAvatarComponent],
    templateUrl: './profile-mutual-line.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileMutualLineComponent {
    readonly profile = input<ProfileDto | undefined>(undefined);

    readonly friendsClick = output<void>();
    readonly serversClick = output<void>();

    protected readonly friendCount = computed(() => this.profile()?.mutualFriends?.length ?? 0);
    protected readonly serverCount = computed(() => this.profile()?.mutualServers?.length ?? 0);
    protected readonly stack = computed(() => (this.profile()?.mutualFriends ?? []).slice(0, STACK_SIZE));
    protected readonly hasAny = computed(() => this.friendCount() > 0 || this.serverCount() > 0);
}
