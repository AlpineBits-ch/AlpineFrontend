import {ChangeDetectionStrategy, Component, computed, inject, input, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';
import {ChannelDto, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {ChannelEncryptionService} from '../../../../../../services/channel-encryption.service';
import {GuildService} from '../../../../../../services/guild.service';
import {MlsToggleConflictDto} from '../../../../../../dtos/mls.dto';
import {
    JoinRequestVerificationError,
    MlsJoinRequestDto,
    MlsJoinRequestService,
} from '../../../../../../services/mls-join-request.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {MlsCoverageDevicesComponent} from '../../../../../../components/mls-coverage-devices/mls-coverage-devices.component';
import {MlsCoverageService} from '../../../../../../services/mls-coverage.service';

@Component({
    selector: 'app-channel-encryption',
    imports: [NgClass, Button, TranslateModule, MlsCoverageDevicesComponent],
    templateUrl: './channel-encryption.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelEncryptionComponent {
    readonly channel = input.required<ChannelDto>();
    readonly guild = input.required<GuildDto>();

    protected readonly encrypted = signal(false);
    protected readonly generation = signal<number | null>(null);
    /** Past eras whose messages are still in the channel but are no longer readable by new members. */
    protected readonly terminatedCount = signal(0);
    protected readonly busy = signal(false);
    protected readonly loading = signal(true);
    protected readonly error = signal<string | null>(null);
    protected readonly retryAfterSeconds = signal<number | null>(null);
    /** Devices that could not be added when enabling; they cannot read anything sent from now on. */
    protected readonly unreachable = signal<string[]>([]);
    protected readonly confirmingDisable = signal(false);

    protected readonly statusLabel = computed(() =>
        this.encrypted() ? 'CHANNEL_SETTINGS.ENCRYPTION.ON' : 'CHANNEL_SETTINGS.ENCRYPTION.OFF',
    );

    /** People asking to be let in, awaiting review. */
    protected readonly joinRequests = signal<MlsJoinRequestDto[]>([]);
    /** Set when an approval was refused because the key did not match what was reviewed. */
    protected readonly verificationError = signal<string | null>(null);
    protected readonly actingOn = signal<string | null>(null);

    /** Gates the slot, so the page's `gap-8` never opens up around an empty section. */
    protected readonly hasDeviceReport = computed(() => this.coverage.hasDeviceReport(this.channel().id));

    private readonly encryption = inject(ChannelEncryptionService);
    private readonly guildService = inject(GuildService);
    private readonly joinRequestService = inject(MlsJoinRequestService);
    private readonly profileService = inject(ProfileService);
    private readonly coverage = inject(MlsCoverageService);

    constructor() {
        void this.refresh();
    }

    protected async refresh(): Promise<void> {
        this.loading.set(true);
        try {
            const state = await this.encryption.state(this.channel().id);
            this.encrypted.set(state.encrypted);
            this.generation.set(state.activeGeneration ?? null);
            this.terminatedCount.set(state.generations.filter(g => g.state === 'Terminated').length);
            await this.refreshJoinRequests();
            // Always refetched here rather than reused from whatever the channel view cached: this is the one screen the user came to in order to ask the question.
            await this.coverage.refresh(this.channel().id, true);
        } catch {
            this.error.set('CHANNEL_SETTINGS.ENCRYPTION.LOAD_FAILED');
        } finally {
            this.loading.set(false);
        }
    }

    protected async refreshJoinRequests(): Promise<void> {
        if (!this.encrypted()) {
            this.joinRequests.set([]);
            return;
        }
        try {
            this.joinRequests.set(
                await firstValueFrom(this.joinRequestService.list(this.channel().id, true)),
            );
        } catch {
            // A failed queue read must not blank out the toggle above it.
            this.joinRequests.set([]);
        }
    }

    /** True once this member has vouched, so the button reads as done rather than inviting a re-click. */
    protected hasApproved(request: MlsJoinRequestDto): boolean {
        const ownId = this.profileService.ownProfile()?.userId;
        return !!ownId && request.approverUserIds.includes(ownId);
    }

    protected canApprove(request: MlsJoinRequestDto): boolean {
        const ownId = this.profileService.ownProfile()?.userId;
        // Vouching for yourself is not review, and the server refuses it anyway.
        return !!ownId && request.requesterUserId !== ownId && !this.hasApproved(request);
    }

    protected async approve(request: MlsJoinRequestDto): Promise<void> {
        if (this.actingOn()) return;
        this.actingOn.set(request.id);
        this.verificationError.set(null);

        try {
            await this.joinRequestService.approve(this.channel().id, true, request);
            await this.refreshJoinRequests();
        } catch (err) {
            if (err instanceof JoinRequestVerificationError) {
                // The bytes did not match what was reviewed; said plainly, since this is the one failure here that might mean tampering rather than a bug.
                this.verificationError.set(err.message);
            } else {
                this.error.set('CHANNEL_SETTINGS.ENCRYPTION.APPROVE_FAILED');
            }
        } finally {
            this.actingOn.set(null);
        }
    }

    protected async deny(request: MlsJoinRequestDto): Promise<void> {
        if (this.actingOn()) return;
        this.actingOn.set(request.id);
        try {
            await firstValueFrom(this.joinRequestService.deny(this.channel().id, true, request.id));
            await this.refreshJoinRequests();
        } catch {
            this.error.set('CHANNEL_SETTINGS.ENCRYPTION.DENY_FAILED');
        } finally {
            this.actingOn.set(null);
        }
    }

    protected async enable(): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        this.retryAfterSeconds.set(null);
        this.unreachable.set([]);

        try {
            const memberIds = await this.channelMemberIds();
            const result = await this.encryption.enable(this.channel().id, memberIds);

            this.encrypted.set(true);
            this.generation.set(result.generation);
            this.unreachable.set(result.unreachableDevices.map(d => d.deviceName));
        } catch (err) {
            this.reportFailure(err, 'CHANNEL_SETTINGS.ENCRYPTION.ENABLE_FAILED');
        } finally {
            this.busy.set(false);
        }
    }

    protected async disable(): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set(null);
        this.retryAfterSeconds.set(null);
        this.confirmingDisable.set(false);

        try {
            const result = await this.encryption.disable(this.channel().id);
            this.encrypted.set(false);
            this.generation.set(null);
            if (result.terminatedGeneration !== null) {
                this.terminatedCount.update(n => n + 1);
            }
        } catch (err) {
            this.reportFailure(err, 'CHANNEL_SETTINGS.ENCRYPTION.DISABLE_FAILED');
        } finally {
            this.busy.set(false);
        }
    }

    /** Everyone who should hold keys for the new group: exactly who can see the channel, resolved server-side against the same permission logic that gates reads. */
    private channelMemberIds(): Promise<string[]> {
        return firstValueFrom(this.guildService.getChannelViewers(this.channel().id));
    }

    private reportFailure(err: unknown, fallback: string): void {
        if (err instanceof HttpErrorResponse && err.status === 409) {
            const conflict = err.error as MlsToggleConflictDto;
            if (conflict?.retryAfterSeconds) {
                // Toggling churns every client's group state; the server spaces retries out so clients reach a steady state rather than thrashing.
                this.retryAfterSeconds.set(conflict.retryAfterSeconds);
                return;
            }
            // Someone else already flipped it. Re-reading is more useful than an error.
            void this.refresh();
            return;
        }
        if (err instanceof HttpErrorResponse && err.status === 403) {
            this.error.set('CHANNEL_SETTINGS.ENCRYPTION.FORBIDDEN');
            return;
        }
        this.error.set(fallback);
    }
}
