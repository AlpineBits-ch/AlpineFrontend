import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {openUrl} from '@tauri-apps/plugin-opener';
import {MessageEmbed} from '../../../../../../dtos/response/message.dto';
import {MarkdownPipe} from '../../../../../../pipes/markdown.pipe';

@Component({
    selector: 'app-embed-card',
    standalone: true,
    imports: [MarkdownPipe],
    templateUrl: './embed-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmbedCardComponent {
    embed = input.required<MessageEmbed>();
    protected readonly openUrl = openUrl;
    protected readonly accentColor = computed(() => this.embed().color || 'var(--color-brand-dim)');
}
