import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {MlsCoverageService} from '../../services/mls-coverage.service';

/** One line of the list, already resolved to the words that go on screen. */
interface StrandedDevice {
    key: string;
    title: string;
    titleParams: Record<string, string>;
    body: string;
}

/** The devices, other than this one, that cannot read a context. Presentation only: the host refetches. */
@Component({
    selector: 'app-mls-coverage-devices',
    imports: [Button, TranslateModule],
    // On the host so the element collapses to nothing when it renders neither block.
    host: {class: 'flex flex-col gap-3'},
    template: `
        @if (devices().length > 0) {
            <section class="flex flex-col gap-2" data-testid="coverage-devices">
                <h2 class="text-sm font-semibold text-text-primary m-0">
                    {{ 'DEVICE_ACCESS.SECTION_TITLE' | translate }}
                </h2>
                @for (device of devices(); track device.key) {
                    <div class="flex items-start gap-3 p-3 rounded-xl bg-card/60 border border-border-subtle">
                        <i class="pi pi-lock text-connecting mt-0.5 text-[0.875rem]"></i>
                        <div class="min-w-0">
                            <p class="text-sm text-text-primary m-0">
                                {{ device.title | translate: device.titleParams }}
                            </p>
                            <p class="text-xs text-text-muted m-0 mt-0.5">{{ device.body | translate }}</p>
                        </div>
                    </div>
                }
            </section>
        }

        <!-- "Could not tell" is a different answer from "nobody is stranded", so the lists above stay standing. -->
        @if (unavailable()) {
            <div class="flex items-center gap-2" data-testid="coverage-unavailable">
                <span class="text-xs text-text-muted">{{ 'DEVICE_ACCESS.UNAVAILABLE' | translate }}</span>
                <p-button
                    (onClick)="retry()"
                    [label]="'DEVICE_ACCESS.RETRY' | translate"
                    [text]="true"
                    severity="secondary"
                    size="small"
                />
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MlsCoverageDevicesComponent {
    readonly contextId = input.required<string>();
    readonly isChannel = input<boolean>(false);
    /** `userId -> display name`, so a peer's device can be named after its owner. Optional. */
    readonly ownerNames = input<Record<string, string>>({});

    /** Falls back to the user id when the roster has not resolved a name. */
    private ownerOf(userId: string): string {
        return this.ownerNames()[userId] ?? userId;
    }

    private readonly coverage = inject(MlsCoverageService);

    protected readonly unavailable = computed(
        () => this.coverage.coverageOf(this.contextId())?.unavailable === true,
    );

    protected readonly devices = computed<StrandedDevice[]>(() => {
        const view = this.coverage.coverageOf(this.contextId());
        if (!view) return [];

        const ownTitle = this.isChannel()
            ? 'DEVICE_ACCESS.OWN_DEVICE_TITLE_CHANNEL'
            : 'DEVICE_ACCESS.OWN_DEVICE_TITLE';

        return [
            ...view.otherOwnDevices.map(device => ({
                key: device.deviceId,
                title: ownTitle,
                titleParams: {device: device.deviceName},
                body: 'DEVICE_ACCESS.OWN_DEVICE_BODY',
            })),
            // No channel variant: the Messaging service cannot enumerate a channel's roster, so
            // this list is always empty for one.
            ...view.peerDevices.map(device => ({
                key: device.deviceId,
                // Not phrased as their fault: their own client tells them the next time they open it.
                title: device.deviceName
                    ? 'DEVICE_ACCESS.PEER_DEVICE_TITLE'
                    : 'DEVICE_ACCESS.PEER_DEVICE_TITLE_NO_NAME',
                titleParams: {owner: this.ownerOf(device.userId), device: device.deviceName},
                body: 'DEVICE_ACCESS.PEER_DEVICE_BODY',
            })),
        ];
    });

    protected retry(): void {
        void this.coverage.refresh(this.contextId(), this.isChannel());
    }
}
