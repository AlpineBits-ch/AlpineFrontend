import {ChangeDetectionStrategy, Component, computed, effect, inject, input} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {GuildOnboardingStateService} from '../../../../services/guild-onboarding-state.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {ChannelDto} from '../../../../dtos/response/guild.dto';

@Component({
    selector: 'app-onboarding-gate',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule],
    templateUrl: './onboarding-gate.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OnboardingGateComponent {
    guildId = input.required<string>();

    protected state = inject(GuildOnboardingStateService);
    private navService = inject(NavigationService);

    protected pending = computed(() => this.state.pendingForGuild(this.guildId()));
    protected status = computed(() => this.state.statusFor(this.guildId()));

    // Guild name/channels come from the already-loaded workspace context rather than a
    // fresh fetch - the gate only ever mounts for the guild currently selected in nav.
    protected guildName = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' && ws.guild.id === this.guildId() ? ws.guild.name : '';
    });

    protected defaultChannels = computed<ChannelDto[]>(() => {
        const ids = this.status()?.defaultChannelIds ?? [];
        if (ids.length === 0) return [];
        const ws = this.navService.workspace();
        if (ws.type !== 'server' || ws.guild.id !== this.guildId()) return [];
        return ws.guild.channels.filter(c => ids.includes(c.id));
    });

    constructor() {
        effect(() => {
            this.state.loadFor(this.guildId());
        });
    }

    protected accept(): void {
        // Restrictions lift immediately on accept - no refetch or reconnect needed, the
        // state service flips pendingForGuild() to false as soon as the request resolves.
        this.state.accept(this.guildId());
    }

    protected openChannel(channel: ChannelDto): void {
        this.navService.openChannel(channel);
    }
}
