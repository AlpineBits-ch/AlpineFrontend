import {Component, inject, input, OnInit, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';
import {GuildService, UpdateChannelDto} from '../../../../../../services/guild.service';

@Component({
  selector: 'app-channel-overview',
  imports: [FormsModule, Button, InputText, Textarea],
  templateUrl: './channel-overview.component.html',
})
export class ChannelOverviewComponent implements OnInit {
  channel = input.required<ChannelDto>();
  channelUpdated = output<ChannelDto>();

  private guildService = inject(GuildService);

  name = signal('');
  description = signal('');
  isPrivate = signal(false);
  isAgeRestricted = signal(false);
  saving = signal(false);
  dirty = signal(false);

  protected readonly ChannelType = ChannelType;

  ngOnInit(): void {
    const c = this.channel();
    this.name.set(c.name);
    this.description.set(c.description ?? '');
    this.isPrivate.set(c.isPrivate);
    this.isAgeRestricted.set(c.isAgeRestricted);
    this.dirty.set(false);
  }

  onChange(): void {
    const c = this.channel();
    this.dirty.set(
      this.name() !== c.name ||
      this.description() !== (c.description ?? '') ||
      this.isPrivate() !== c.isPrivate ||
      this.isAgeRestricted() !== c.isAgeRestricted
    );
  }

  save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    const dto: UpdateChannelDto = {
      name: this.name(),
      description: this.description(),
      isPrivate: this.isPrivate(),
      isAgeRestricted: this.isAgeRestricted(),
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
