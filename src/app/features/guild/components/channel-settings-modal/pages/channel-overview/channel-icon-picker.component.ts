import {ChangeDetectionStrategy, Component, computed, input, model, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {CHANNEL_ICON_CATALOG, CHANNEL_ICON_GROUPS} from '../../../../channel-icon-catalog';
import {CHANNEL_ICON_PALETTE} from '../../../../channel-icon-palette';
import {ChannelIconComponent} from '../../../channel-icon/channel-icon.component';
import {LucideIconComponent} from '../../../../../../components/lucide-icon/lucide-icon.component';

@Component({
    selector: 'app-channel-icon-picker',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, ChannelIconComponent, LucideIconComponent],
    templateUrl: './channel-icon-picker.component.html',
})
export class ChannelIconPickerComponent {
    /** `''` means the channel type's own icon. */
    readonly icon = model('');
    /** `''` means the uniform default colour. */
    readonly iconColor = model('');
    readonly channelType = input.required<ChannelType>();

    protected readonly open = signal(false);
    protected readonly search = signal('');

    protected get palette() {
        return CHANNEL_ICON_PALETTE;
    }

    protected readonly preview = computed(() => ({
        type: this.channelType(),
        icon: this.icon() || undefined,
        iconColor: this.iconColor() || undefined,
    }));

    protected readonly groups = computed(() => {
        const term = this.search().trim().toLowerCase();
        const matching = term
            ? CHANNEL_ICON_CATALOG.filter(e => e.name.includes(term))
            : CHANNEL_ICON_CATALOG;
        return CHANNEL_ICON_GROUPS.map(group => ({
            group,
            entries: matching.filter(e => e.group === group),
        })).filter(g => g.entries.length > 0);
    });

    protected toggle(): void {
        this.open.update(v => !v);
    }

    protected choose(name: string): void {
        this.icon.set(name);
        this.open.set(false);
    }

    protected clearIcon(): void {
        this.icon.set('');
        this.open.set(false);
    }

    protected onSearch(event: Event): void {
        this.search.set((event.target as HTMLInputElement).value);
    }
}
