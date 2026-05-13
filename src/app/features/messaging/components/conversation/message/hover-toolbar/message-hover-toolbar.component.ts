import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ReactionPickerComponent } from '../reaction-picker/reaction-picker.component';

@Component({
  selector: 'app-message-hover-toolbar',
  imports: [ReactionPickerComponent],
  templateUrl: './message-hover-toolbar.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageHoverToolbarComponent {
  isOwn = input.required<boolean>();

  reply = output<void>();
  edit = output<void>();
  delete = output<void>();
  emojiToggled = output<string>();

  readonly quickReactions = ['👍', '❤️', '😂'];
}
