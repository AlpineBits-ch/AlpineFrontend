import {Component, inject, input, OnInit, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';
import {GuildService, UpdateChannelDto} from '../../../../../../services/guild.service';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelIconComponent} from '../../../channel-icon/channel-icon.component';
import {ChannelIconPickerComponent} from './channel-icon-picker.component';

@Component({
    selector: 'app-channel-overview',
    imports: [
        FormsModule,
        ToggleSwitch,
        Button,
        InputText,
        Textarea,
        TranslateModule,
        ChannelIconComponent,
        ChannelIconPickerComponent,
    ],
    templateUrl: './channel-overview.component.html',
})
export class ChannelOverviewComponent implements OnInit {
    readonly channel = input.required<ChannelDto>();
    channelUpdated = output<ChannelDto>();
    readonly name = signal('');
    readonly description = signal('');
    readonly isAgeRestricted = signal(false);
    readonly slowModeSeconds = signal(0);
    readonly icon = signal('');
    readonly iconColor = signal('');
    readonly saving = signal(false);
    readonly dirty = signal(false);
    protected readonly ChannelType = ChannelType;
    private guildService = inject(GuildService);

    ngOnInit(): void {
        const c = this.channel();
        this.name.set(c.name);
        this.description.set(c.description ?? '');
        this.isAgeRestricted.set(c.isAgeRestricted);
        this.slowModeSeconds.set(c.slowModeSeconds);
        this.icon.set(c.icon ?? '');
        this.iconColor.set(c.iconColor ?? '');
        this.dirty.set(false);
    }

    onChange(): void {
        const c = this.channel();
        this.dirty.set(
            this.name() !== c.name ||
                this.description() !== (c.description ?? '') ||
                this.isAgeRestricted() !== c.isAgeRestricted ||
                this.slowModeSeconds() !== c.slowModeSeconds ||
                this.icon() !== (c.icon ?? '') ||
                this.iconColor() !== (c.iconColor ?? ''),
        );
    }

    save(): void {
        if (this.saving()) return;
        this.saving.set(true);
        const dto: UpdateChannelDto = {
            name: this.name(),
            description: this.description(),
            isPrivate: this.channel().isPrivate,
            isAgeRestricted: this.isAgeRestricted(),
            slowModeSeconds: this.slowModeSeconds(),
            icon: this.icon(),
            iconColor: this.iconColor(),
        };
        this.guildService.updateChannel(this.channel().id, dto).subscribe({
            next: updated => {
                this.channelUpdated.emit(updated);
                this.dirty.set(false);
                this.saving.set(false);
            },
            error: () => this.saving.set(false),
        });
    }
}
