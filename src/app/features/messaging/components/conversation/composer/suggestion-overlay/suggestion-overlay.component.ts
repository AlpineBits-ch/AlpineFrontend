import {Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {Avatar} from 'primeng/avatar';
import {ComposerCommandItem} from '../commands';
import {EmojiSuggestion} from '../../../../../../services/emoji-data.service';
import {MentionCandidate, mentionCandidateId} from '../composer-utils';
import {TwemojiComponent} from '../../../../../../components/twemoji/twemoji.component';
import {UserNameStyleDirective} from '../../../../../../directives/user-name-style.directive';
import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';
import {WikiPageSummaryDto} from '../../../../../../dtos/response/wiki.dto';
import {channelIcon as iconForType} from '../../../../../guild/channel-types';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-suggestion-overlay',
    imports: [NgClass, Avatar, TwemojiComponent, UserNameStyleDirective, TranslateModule],
    templateUrl: './suggestion-overlay.component.html',
    styleUrl: './suggestion-overlay.component.css',
})
export class SuggestionOverlayComponent {
    overlayType = input<'mention' | 'command' | 'emoji' | 'channel' | 'wiki' | null>(null);
    filteredMentions = input<MentionCandidate[]>([]);
    filteredCommands = input<ComposerCommandItem[]>([]);
    filteredEmojis = input<EmojiSuggestion[]>([]);
    filteredChannels = input<ChannelDto[]>([]);
    filteredWikiPages = input<WikiPageSummaryDto[]>([]);
    selectedIndex = input<number>(0);
    query = input<string>('');

    mentionSelected = output<MentionCandidate>();
    commandSelected = output<ComposerCommandItem>();
    emojiSelected = output<EmojiSuggestion>();
    channelSelected = output<ChannelDto>();
    wikiPageSelected = output<WikiPageSummaryDto>();

    protected readonly mentionCandidateId = mentionCandidateId;
    protected readonly ChannelType = ChannelType;

    /** Text has no glyph of its own, so it falls back to the hash it renders everywhere else. */
    protected channelIcon(type: ChannelType): string {
        return iconForType(type) ?? 'pi pi-hashtag';
    }
}
