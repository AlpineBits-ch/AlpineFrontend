import {ChangeDetectionStrategy, Component, computed, effect, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {MessageDto} from '../../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../../enums/message-type.enum';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfilePopoutService} from '../../../../../../services/profile-popout.service';
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';
import {decodeContent} from '../../message-utils';

const JOIN_VARIANT_KEYS = Array.from({length: 10}, (_, i) => `MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.${i}`);
const LEAVE_VARIANT_KEYS = Array.from({length: 10}, (_, i) => `MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.${i}`);

@Component({
    selector: 'app-system-message',
    imports: [TranslateModule, UserNameStyleDirective],
    templateUrl: './system-message.component.html',
    styleUrl: './system-message.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemMessageComponent {
    public readonly message = input.required<MessageDto>();
    public readonly userToken = '%USER%';
    public profilePopout = inject(ProfilePopoutService);
    private profileService = inject(ProfileService);

    constructor() {
        effect(() => this.profileService.resolveByUserId(this.message().authorId));
    }

    /** True for the two call notices, which carry no variant copy and are worded per outcome. */
    private readonly isCall = computed(() => {
        const type = this.message().type;
        return type === MessageType.CallEnded || type === MessageType.CallMissed;
    });

    /**
     * A call notice is authored by whoever placed the call, so the caller reads their own entry.
     * "You missed a call from yourself" is the sentence that has to be avoided.
     */
    private readonly isOwnCall = computed(
        () => this.message().authorId === this.profileService.ownProfile()?.userId,
    );

    /** The group's new name, from `content`. Empty means the name was cleared. */
    private readonly groupName = computed(() => decodeContent(this.message().content ?? '').trim());

    public readonly variantKey = computed(() => {
        const msg = this.message();

        if (msg.type === MessageType.GroupNameChanged) {
            return this.groupName()
                ? 'MESSAGE.SYSTEM.GROUP_NAME_CHANGED'
                : 'MESSAGE.SYSTEM.GROUP_NAME_CLEARED';
        }
        if (msg.type === MessageType.GroupIconChanged) {
            return this.groupName() === 'removed'
                ? 'MESSAGE.SYSTEM.GROUP_ICON_REMOVED'
                : 'MESSAGE.SYSTEM.GROUP_ICON_CHANGED';
        }

        if (msg.type === MessageType.CallMissed) {
            return this.isOwnCall() ? 'MESSAGE.SYSTEM.CALL_MISSED_OWN' : 'MESSAGE.SYSTEM.CALL_MISSED';
        }
        // A duration-less variant rather than copy with a hole in it: the server writes the seconds
        // into `content`, and a message that predates that (or arrives malformed) still has to read
        // as a sentence.
        if (msg.type === MessageType.CallEnded) {
            return this.duration() ? 'MESSAGE.SYSTEM.CALL_ENDED' : 'MESSAGE.SYSTEM.CALL_ENDED_NO_DURATION';
        }

        const keys = msg.type === MessageType.GuildMemberLeave ? LEAVE_VARIANT_KEYS : JOIN_VARIANT_KEYS;
        const variant = msg.systemMessageVariant ?? 0;
        const index = variant >= 0 && variant < keys.length ? variant : 0;
        return keys[index];
    });

    /** Interpolation for the copy that takes parameters. Empty for everything else. */
    public readonly translateParams = computed(() => {
        if (this.isCall()) return {duration: this.duration()};
        if (this.message().type === MessageType.GroupNameChanged) return {name: this.groupName()};
        return {};
    });

    /** The call's length, from the whole seconds the server puts in `content`. */
    public readonly duration = computed(() => {
        if (this.message().type !== MessageType.CallEnded) return '';
        const seconds = Number.parseInt(decodeContent(this.message().content ?? ''), 10);
        return Number.isFinite(seconds) && seconds >= 0 ? formatDuration(seconds) : '';
    });

    public readonly userProfile = computed(() =>
        this.profileService.getCachedByUserId(this.message().authorId),
    );

    public readonly userDisplayName = computed(() => this.userProfile()?.userName ?? this.message().authorId);

    public openProfile(): void {
        this.profilePopout.open(this.message().authorId);
    }
}

/** `45s`, `3m 4s`, `1h 2m` - the largest two units, so a long call does not read as a wall of digits. */
export function formatDuration(totalSeconds: number): string {
    const seconds = Math.floor(totalSeconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${rest}s`;
    return `${rest}s`;
}
