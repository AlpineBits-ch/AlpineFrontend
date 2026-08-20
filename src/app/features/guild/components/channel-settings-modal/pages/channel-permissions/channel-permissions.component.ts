import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {ChannelDto, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {PermissionOverridesComponent} from '../../../../shared/permission-overrides/permission-overrides.component';
import {channelScope} from '../../../../shared/permission-overrides/permission-scope';

@Component({
    selector: 'app-channel-permissions',
    imports: [PermissionOverridesComponent],
    templateUrl: './channel-permissions.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelPermissionsComponent {
    readonly channel = input.required<ChannelDto>();
    readonly guild = input.required<GuildDto>();

    protected readonly scope = computed(() => channelScope(this.channel()));
}
