import {Component, inject, input, signal} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {MlsJoinRequestDto, MlsJoinRequestService} from '../../../../services/mls-join-request.service';

/** Shown when a channel is encrypted and this device is not in its group; admission needs a member to vouch, so the fingerprint shown here is what the reviewer reads out. */
@Component({
    selector: 'app-channel-access-banner',
    imports: [Button, TranslateModule],
    templateUrl: './channel-access-banner.component.html',
})
export class ChannelAccessBannerComponent {
    readonly channelId = input.required<string>();

    protected readonly pending = signal<MlsJoinRequestDto | null>(null);
    protected readonly fingerprint = signal<string | null>(null);
    protected readonly busy = signal(false);
    protected readonly error = signal<string | null>(null);

    private readonly joinRequests = inject(MlsJoinRequestService);

    constructor() {
        void this.load();
    }

    protected async load(): Promise<void> {
        try {
            const [pending, fingerprint] = await Promise.all([
                this.joinRequests.myPendingRequest(this.channelId(), true),
                this.joinRequests.ownFingerprint(),
            ]);
            this.pending.set(pending);
            this.fingerprint.set(fingerprint);
        } catch {
            // The banner's job is to explain and offer a way out; failing to read the queue shouldn't take the explanation away too.
            this.pending.set(null);
        }
    }

    protected async request(): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set(null);

        try {
            this.pending.set(await this.joinRequests.requestAccess(this.channelId(), true));
        } catch {
            this.error.set('CHANNEL_SETTINGS.ENCRYPTION.REQUEST_FAILED');
        } finally {
            this.busy.set(false);
        }
    }

    protected async withdraw(): Promise<void> {
        const pending = this.pending();
        if (!pending || this.busy()) return;
        this.busy.set(true);
        this.error.set(null);

        try {
            await firstValueFrom(this.joinRequests.cancel(this.channelId(), true, pending.id));
            this.pending.set(null);
        } catch {
            this.error.set('CHANNEL_SETTINGS.ENCRYPTION.WITHDRAW_FAILED');
        } finally {
            this.busy.set(false);
        }
    }
}
