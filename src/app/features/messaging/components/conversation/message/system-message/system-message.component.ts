import {ChangeDetectionStrategy, Component, computed, effect, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {MessageDto} from '../../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../../enums/message-type.enum';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileDialogService} from '../../../../../../services/profile-dialog.service';
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';

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
    public message = input.required<MessageDto>();
    public readonly userToken = '%USER%';
    public profileDialogSvc = inject(ProfileDialogService);
    private profileService = inject(ProfileService);

    constructor() {
        effect(() => this.profileService.resolveByUserId(this.message().authorId));
    }

    public readonly variantKey = computed(() => {
        const msg = this.message();
        const keys = msg.type === MessageType.GuildMemberLeave ? LEAVE_VARIANT_KEYS : JOIN_VARIANT_KEYS;
        const variant = msg.systemMessageVariant ?? 0;
        const index = variant >= 0 && variant < keys.length ? variant : 0;
        return keys[index];
    });

    public readonly userProfile = computed(() => this.profileService.getCachedByUserId(this.message().authorId));

    public readonly userDisplayName = computed(() => this.userProfile()?.userName ?? this.message().authorId);

    public openProfile(): void {
        this.profileDialogSvc.open(this.message().authorId);
    }
}
