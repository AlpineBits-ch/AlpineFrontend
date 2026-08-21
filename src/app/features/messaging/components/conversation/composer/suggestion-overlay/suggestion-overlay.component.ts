import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {Avatar} from 'primeng/avatar';
import {ComposerCommandItem} from '../commands';
import {EmojiSuggestion} from '../../../../../../services/emoji-data.service';
import {MentionCandidate, mentionCandidateId} from '../composer-utils';
import {TwemojiComponent} from '../../../../../../components/twemoji/twemoji.component';
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {WikiPageSummaryDto} from '../../../../../../dtos/response/wiki.dto';
import {PersonaAvatarComponent} from '../../../../../guild/personas/persona-avatar/persona-avatar.component';
import {ChannelIconComponent} from '../../../../../guild/components/channel-icon/channel-icon.component';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-suggestion-overlay',
    imports: [
        NgClass,
        Avatar,
        TwemojiComponent,
        UserNameStyleDirective,
        PersonaAvatarComponent,
        ChannelIconComponent,
        TranslateModule,
    ],
    templateUrl: './suggestion-overlay.component.html',
    styleUrl: './suggestion-overlay.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SuggestionOverlayComponent {
    readonly overlayType = input<'mention' | 'command' | 'emoji' | 'channel' | 'wiki' | null>(null);
    readonly filteredMentions = input<MentionCandidate[]>([]);
    readonly filteredCommands = input<ComposerCommandItem[]>([]);
    readonly filteredEmojis = input<EmojiSuggestion[]>([]);
    readonly filteredChannels = input<ChannelDto[]>([]);
    readonly filteredWikiPages = input<WikiPageSummaryDto[]>([]);
    readonly selectedIndex = input<number>(0);
    readonly query = input<string>('');

    mentionSelected = output<MentionCandidate>();
    commandSelected = output<ComposerCommandItem>();
    emojiSelected = output<EmojiSuggestion>();
    channelSelected = output<ChannelDto>();
    wikiPageSelected = output<WikiPageSummaryDto>();

    protected readonly mentionCandidateId = mentionCandidateId;
}
