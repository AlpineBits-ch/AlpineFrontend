import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {NavigationService} from '../../../main-page/navigation.service';
import {ForumPostListComponent} from './forum-post-list.component';
import {ChannelIconComponent} from '../channel-icon/channel-icon.component';

/** Full-width forum view: channel header, then ForumPostListComponent for everything else (toolbar, filters, posts, create dialog); also mounts compact beside an open post. */
@Component({
    selector: 'app-forum-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, ForumPostListComponent, ChannelIconComponent],
    templateUrl: './forum-channel.component.html',
})
export class ForumChannelComponent {
    readonly channel = input.required<ChannelDto>();
    back = output();

    protected navService = inject(NavigationService);

    protected readonly isMedia = computed(() => this.channel().type === ChannelType.Media);
}
