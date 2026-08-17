import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {GuildTemplateDto, TemplateCategory, TemplateChannel, TemplateRole} from '../../../../dtos/response/guild-template.dto';
import {channelIcon as iconForType} from '../../channel-types';

@Component({
    selector: 'app-template-preview',
    imports: [TranslateModule],
    templateUrl: './template-preview.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatePreviewComponent {
    readonly template = input.required<GuildTemplateDto>();

    readonly categories = computed<TemplateCategory[]>(() =>
        [...this.template().snapshot.categories].sort((a, b) => a.position - b.position)
            .map(c => ({...c, channels: [...c.channels].sort((a, b) => a.position - b.position)}))
    );

    readonly uncategorizedChannels = computed<TemplateChannel[]>(() =>
        [...this.template().snapshot.uncategorizedChannels].sort((a, b) => a.position - b.position)
    );

    readonly roles = computed<TemplateRole[]>(() =>
        [...this.template().snapshot.roles].sort((a, b) => a.position - b.position)
    );

    readonly channelCount = computed(() =>
        this.categories().reduce((sum, c) => sum + c.channels.length, 0) + this.uncategorizedChannels().length
    );

    /** The shared table, with a hash for anything it has no glyph for: Text returns null by design, and a template from a newer server may name a type this build lacks. */
    channelIcon(type: ChannelType): string {
        return iconForType(type) ?? 'pi pi-hashtag';
    }
}
