import {Component, computed, effect, inject, OnDestroy, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {Slider} from 'primeng/slider';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {take} from 'rxjs';
import {IsleProximityService} from '../../services/isle-proximity.service';
import {AudioSettingsService} from '../../services/audio-settings.service';
import {HotkeyService} from '../../services/hotkey.service';
import {KeybindsService} from '../../services/keybinds.service';
import {SteamService} from '../../services/steam.service';
import {ExternalLinkService} from '../../services/external-link.service';
import {ToastService} from '../../services/toast.service';

type BarMode = 'linkSteam' | 'available' | 'connecting' | 'connected';

/**
 * App-wide bar offering Isle proximity voice. Appears whenever the player's Isle
 * character is connected to a game server; its content depends on link/voice state.
 * Modeled on VoiceStatusBarComponent's visual idiom.
 */
@Component({
    selector: 'app-isle-proximity-bar',
    imports: [NgClass, FormsModule, TranslateModule, Slider, ToggleSwitch],
    templateUrl: './isle-proximity-bar.component.html',
})
export class IsleProximityBarComponent implements OnInit, OnDestroy {
    protected prox = inject(IsleProximityService);
    private audioSettings = inject(AudioSettingsService);
    private hotkey = inject(HotkeyService);
    private keybinds = inject(KeybindsService);
    private steamService = inject(SteamService);
    private externalLink = inject(ExternalLinkService);
    private toast = inject(ToastService);

    protected linkingSteam = signal(false);
    private now = signal(Date.now());
    private timerHandle: ReturnType<typeof setInterval> | null = null;

    /** The bar is only present while the character is in-game or voice is active. */
    protected visible = computed(() => this.prox.isGameConnected() || this.prox.isVoiceActive());

    protected mode = computed<BarMode>(() => {
        if (this.prox.isVoiceActive()) return 'connected';
        if (this.prox.isConnecting()) return 'connecting';
        if (!this.prox.isLinked()) return 'linkSteam';
        return 'available';
    });

    protected elapsed = computed(() => {
        const since = this.prox.connectedSince();
        if (!since) return '';
        const total = Math.max(0, Math.floor((this.now() - since) / 1000));
        const m = Math.floor(total / 60).toString().padStart(2, '0');
        const s = (total % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    });

    /** Display label for the bound key; resolved asynchronously, see the effect below. */
    protected pttKey = signal('');
    protected pttSupported = this.hotkey.supported;
    /** Push-to-talk takes priority over toggle-mute for this single-line hint if both are bound. */
    protected hintKind = computed<'none' | 'ptt' | 'mute'>(() => {
        if (this.keybinds.getBinding('isle-ptt')) return 'ptt';
        if (this.keybinds.getBinding('isle-toggle-mute')) return 'mute';
        return 'none';
    });

    protected get volumePct(): number {
        return Math.round(this.audioSettings.settings().proximityVolume * 100);
    }

    protected set volumePct(v: number) {
        this.prox.setVolume(Math.max(0, Math.min(1, v / 100)));
    }

    protected get micBoostPct(): number {
        return Math.round(this.audioSettings.settings().proximityMicGain * 100);
    }

    protected set micBoostPct(v: number) {
        this.prox.setMicGain(Math.max(0, Math.min(2, v / 100)));
    }

    protected get spatialEnabled(): boolean {
        return this.audioSettings.settings().proximitySpatialEnabled;
    }

    protected set spatialEnabled(v: boolean) {
        this.prox.setSpatialEnabled(v);
    }

    constructor() {
        // Keep the hint in sync with rebinds; the native hook is the only thing
        // that can turn its own tokens (VK86, MouseX2) into something readable.
        effect(() => {
            const kind = this.hintKind();
            const id = kind === 'ptt' ? 'isle-ptt' : kind === 'mute' ? 'isle-toggle-mute' : null;
            if (!id) {
                this.pttKey.set('');
                return;
            }
            void this.keybinds.labelFor(id).then(label => this.pttKey.set(label));
        });
    }

    ngOnInit(): void {
        this.timerHandle = setInterval(() => this.now.set(Date.now()), 1000);
    }

    ngOnDestroy(): void {
        if (this.timerHandle !== null) clearInterval(this.timerHandle);
    }

    protected connect(): void {
        void this.prox.join();
    }

    protected disconnect(): void {
        void this.prox.leave();
    }

    protected linkSteam(): void {
        if (this.linkingSteam()) return;
        this.linkingSteam.set(true);
        this.steamService.getLinkStartUrl().pipe(take(1)).subscribe({
            next: ({redirectUrl}) => {
                // Steam login opens in the browser; the result returns via the
                // venta://steam-auth deep link handled in AppComponent/SteamService.
                void this.externalLink.openExternalLink(redirectUrl);
                this.linkingSteam.set(false);
            },
            error: err => {
                this.linkingSteam.set(false);
                this.toast.httpError('Could not start Steam linking', err);
            },
        });
    }
}
