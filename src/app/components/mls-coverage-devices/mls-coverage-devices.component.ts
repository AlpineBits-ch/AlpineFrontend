import {Component, computed, inject, input} from '@angular/core';
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

/**
 * The devices, other than this one, that cannot read a context.
 *
 * <p><b>This screen and nowhere else.</b> Neither of the two situations it covers - another of your
 * machines, or somebody else's - is an inconvenience the reader is currently having, and neither
 * has an action available from here: a stranded device has to ask for itself. A badge, a dot on the
 * conversation list or a push for something the person cannot act on and is not suffering from is a
 * warning they learn to dismiss, and dismissing it is learned for the ones that matter too.</p>
 *
 * <p>The moments where this information genuinely changes a decision - creating an encrypted
 * conversation, and adding someone to one - are already covered on those write paths, at the
 * instant the decision is being made. Afterwards it is reference material, which is what this is.</p>
 *
 * <p>Presentation only: the screen that hosts it is what refetches, because "the user opened the
 * encryption screen" is a fact the screen knows and this widget does not. That also lets a host
 * gate its own section header and padding on {@link MlsCoverageService.hasDeviceReport} without
 * deadlocking against a fetch that would only have been started by rendering.</p>
 */
@Component({
    selector: 'app-mls-coverage-devices',
    imports: [Button, TranslateModule],
    // On the host so the list and the could-not-check line are spaced when both are present, and
    // so the element collapses to nothing when neither is - a gap only applies between items.
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

        <!--
          Only here, and only because the user came looking. "Could not tell" is a different answer
          from "nobody is stranded", and the lists above are deliberately left standing rather than
          cleared - see MlsCoverageService.markUnavailable.
        -->
        @if (unavailable()) {
            <div class="flex items-center gap-2" data-testid="coverage-unavailable">
                <span class="text-xs text-text-muted">{{ 'DEVICE_ACCESS.UNAVAILABLE' | translate }}</span>
                <p-button (onClick)="retry()" [label]="'DEVICE_ACCESS.RETRY' | translate"
                          [text]="true" severity="secondary" size="small"/>
            </div>
        }
    `,
})
export class MlsCoverageDevicesComponent {
    readonly contextId = input.required<string>();
    readonly isChannel = input<boolean>(false);
    /**
     * `userId -> display name`, so a peer's device can be named after its owner.
     *
     * Optional because the coverage response carries a user id and a device name and nothing else,
     * and inventing a lookup service for it would put a request behind a reference screen. Callers
     * that already hold the roster pass it; the rest get the device name on its own.
     */
    readonly ownerNames = input<Record<string, string>>({});

    /**
     * Falls back to the user id when the roster has not resolved a name.
     *
     * <p>Ugly, and deliberately preferred to dropping the row or writing "someone": the reader is
     * on a screen they opened to find out which devices are outside, and an opaque owner is still
     * an answer. The row is about the device either way.</p>
     */
    private ownerOf(userId: string): string {
        return this.ownerNames()[userId] ?? userId;
    }

    private readonly coverage = inject(MlsCoverageService);

    protected readonly unavailable = computed(
        () => this.coverage.coverageOf(this.contextId())?.unavailable === true);

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
                // Not phrased as their fault, and with no offer to notify them: they are told by
                // their own client, the next time they open it.
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
