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
    readonly isOwn = input.required<boolean>();
    readonly canPin = input<boolean>(false);
    readonly isPinned = input<boolean>(false);
    readonly guildId = input<string | undefined>();
    readonly canPublish = input<boolean>(false);
    readonly isPublished = input<boolean>(false);

    reply = output<void>();
    edit = output<void>();
    delete = output<void>();
    report = output<void>();
    emojiToggled = output<EmojiSelection>();
    pinToggled = output<void>();
    publish = output<void>();

    readonly quickReactions = ['👍', '❤️', '😂'];
}
