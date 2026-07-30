import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {NavigationService} from '../../../main-page/navigation.service';
import {ForumPostListComponent} from './forum-post-list.component';

/**
 * The full-width forum view: the channel header, and beneath it the post list. Everything
 * about the list itself - toolbar, filters, posts, create dialog - is ForumPostListComponent,
 * which also mounts compact in the narrow pane beside an open post.
 */
@Component({
    selector: 'app-forum-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, ForumPostListComponent],
    templateUrl: './forum-channel.component.html',
})
export class ForumChannelComponent {
    channel = input.required<ChannelDto>();
    back = output();

    protected navService = inject(NavigationService);

    protected isMedia = computed(() => this.channel().type === ChannelType.Media);
}
