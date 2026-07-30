import {Component, computed, effect, inject, input, model, signal, untracked} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {GuildFeature, GuildFeatureSet} from '../../../../guild-features';
import {channelIcon, HOUSEHOLD_CHANNEL_META, householdFeatureFor} from '../../../../channel-types';

@Component({
    selector: 'app-create-channel-modal',
    imports: [NgClass, Dialog, Button, InputText, PrimeTemplate, TranslateModule],
    templateUrl: './create-channel-modal.component.html',
})
export class CreateChannelModalComponent {
    isVisible = model.required<boolean>();
    guildId = input.required<string>();
    /** The guild's module set: a channel type whose module is off can't be created at all. */
    guildFeatures = input.required<GuildFeatureSet>();

    protected readonly ChannelType = ChannelType;
    /**
     * Text has no module behind it - a guild without text channels would be an empty
     * room - so it is always offered. The rest each answer to one flag.
     */
    protected canVoice = computed(() => this.guildFeatures().has(GuildFeature.VoiceChannels));
    /** One flag covers Forum *and* Media; they are the same channel drawn two ways. */
    protected canForum = computed(() => this.guildFeatures().has(GuildFeature.Forums));
    protected canAnnouncement = computed(() => this.guildFeatures().has(GuildFeature.Announcements));
    /** Only the household types whose module this guild actually has. */
    protected householdTypes = computed(() =>
        HOUSEHOLD_CHANNEL_META.filter(meta => meta.feature !== null && this.guildFeatures().has(meta.feature)));
    protected hasTypeChoice = computed(() =>
        this.canVoice() || this.canForum() || this.canAnnouncement() || this.householdTypes().length > 0);
    /** The glyph inside the name field - the same table the sidebar row reads. */
    protected selectedIcon = computed(() => channelIcon(this.type()));
    protected name = signal('');
    protected type = signal<ChannelType>(ChannelType.Text);
    protected creating = signal(false);
    protected categoryId = signal<string | undefined>(undefined);
    private position = signal(0);
    private guildService = inject(GuildService);

    constructor() {
        // A second admin can switch a module off while this dialog is open. Creating that
        // type would come back a 400, so the selection falls back to the one type that is
        // never gated rather than leaving a dead Create button.
        effect(() => {
            const type = this.type();
            const householdFeature = householdFeatureFor(type);
            const stranded = (type === ChannelType.Voice && !this.canVoice())
                || ((type === ChannelType.Forum || type === ChannelType.Media) && !this.canForum())
                || (type === ChannelType.Announcement && !this.canAnnouncement())
                || (householdFeature !== null && !this.guildFeatures().has(householdFeature));
            if (stranded) untracked(() => this.type.set(ChannelType.Text));
        });
    }

    open(categoryId: string | undefined, position: number): void {
        this.name.set('');
        this.type.set(ChannelType.Text);
        this.categoryId.set(categoryId);
        this.position.set(position);
        this.isVisible.set(true);
    }

    /** Channel names carry no whitespace - every space becomes a dash as the user types. */
    protected onNameInput(event: Event): void {
        const el = event.target as HTMLInputElement;
        const sanitized = el.value.replace(/\s/g, '-');
        if (sanitized !== el.value) {
            const caret = el.selectionStart;
            el.value = sanitized;
            if (caret !== null) el.setSelectionRange(caret, caret);
        }
        this.name.set(sanitized);
    }

    protected submit(): void {
        if (this.creating() || !this.name().trim()) return;
        this.creating.set(true);
        this.guildService.createChannel({
            guildId: this.guildId(),
            name: this.name().trim(),
            type: this.type(),
            categoryId: this.categoryId(),
            position: this.position(),
        }).subscribe({
            next: () => {
                this.isVisible.set(false);
                this.creating.set(false);
            },
            error: () => this.creating.set(false),
        });
    }
}
