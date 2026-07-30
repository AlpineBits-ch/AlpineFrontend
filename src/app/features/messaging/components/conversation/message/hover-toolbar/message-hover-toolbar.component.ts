import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
import {ReactionPickerComponent, EmojiSelection} from '../reaction-picker/reaction-picker.component';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-message-hover-toolbar',
    imports: [ReactionPickerComponent, TranslateModule],
    templateUrl: './message-hover-toolbar.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageHoverToolbarComponent {
    isOwn = input.required<boolean>();
    guildId = input<string | undefined>();

    reply = output<void>();
    edit = output<void>();
    delete = output<void>();
    emojiToggled = output<EmojiSelection>();

    readonly quickReactions = ['👍', '❤️', '😂'];
}
