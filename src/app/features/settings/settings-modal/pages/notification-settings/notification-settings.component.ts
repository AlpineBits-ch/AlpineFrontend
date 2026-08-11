import {Component, ElementRef, inject, signal, viewChild} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {UserSettingsService} from '../../../../../services/user-settings.service';
import {SoundKey, SoundSettingsService} from '../../../../../services/sound-settings.service';
import {NotificationService} from '../../../../../services/notification.service';
import {PlatformCapabilities} from '../../../../../platform/capabilities';

@Component({
    selector: 'app-notification-settings',
    imports: [ToggleSwitch, FormsModule, TranslateModule],
    templateUrl: './notification-settings.component.html',
    styleUrl: './notification-settings.component.css',
})
export class NotificationSettingsComponent {
    protected readonly userSettings = inject(UserSettingsService);
    protected readonly soundSettings = inject(SoundSettingsService);

    /**
     * Whether the host has durably refused to show notifications.
     *
     * <p><b>Nothing read this before, which is the bug.</b> In a browser a denied permission cannot be
     * re-requested by the app, so "Enable Notifications" could sit there switched on, look entirely
     * correct, and deliver nothing at all.</p>
     *
     * <p>The switch is <i>not</i> disabled on the strength of it. It still gates the sound and the
     * cooldown below, both of which keep working while the toast is blocked, so disabling it would
     * take away two controls that do work in order to describe one that does not. What the page owes
     * the user here is the sentence, not a dead switch.</p>
     */
    protected readonly notifications = inject(NotificationService);

    /**
     * Read for `backgroundPush`, and deliberately not for `nativeToasts`.
     *
     * <p>A browser tab shows toasts perfectly well; what it cannot do is receive anything once it is
     * closed. Rendering that as "notifications do not work here" would be wrong in the direction that
     * loses messages the user believes they will be told about, so the copy says what is true:
     * notifications arrive only while Venta is open.</p>
     */
    protected readonly capabilities = inject(PlatformCapabilities);

    protected readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
    protected readonly uploadError = signal('');
    protected readonly soundItems: Array<{ key: SoundKey; label: string; description: string }> = [
        {key: 'incomingCall', label: 'Incoming Call', description: 'Plays when someone calls you.'},
        {key: 'outgoingCall', label: 'Outgoing Call', description: 'Plays while your call is connecting.'},
        {key: 'message', label: 'Messages', description: 'Plays when a new message arrives.'},
        {key: 'voiceJoin', label: 'Voice Join', description: 'Plays when you join a voice channel.'},
        {key: 'voiceLeave', label: 'Voice Leave', description: 'Plays when you leave a voice channel.'},
    ];
    private currentUploadKey: SoundKey | null = null;

    protected preview(key: SoundKey): void {
        switch (key) {
            case 'incomingCall':
                this.soundSettings.playIncomingRing();
                break;
            case 'outgoingCall':
                this.soundSettings.playRingback();
                break;
            case 'message':
                this.soundSettings.playMessage();
                break;
            case 'voiceJoin':
                this.soundSettings.playVoiceJoin();
                break;
            case 'voiceLeave':
                this.soundSettings.playVoiceLeave();
                break;
        }
    }

    protected triggerUpload(key: SoundKey): void {
        this.currentUploadKey = key;
        this.uploadError.set('');
        this.fileInput()?.nativeElement.click();
    }

    protected onFileSelected(event: Event): void {
        const key = this.currentUploadKey;
        this.currentUploadKey = null;
        if (!key) return;

        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
            this.uploadError.set('File too large (max 5 MB).');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            this.soundSettings.update(key, {customUrl: reader.result as string, customName: file.name});
        };
        reader.readAsDataURL(file);
    }

    protected onCooldownSecondsChange(value: string): void {
        const seconds = Math.max(1, Math.min(300, Number(value)));
        if (!isNaN(seconds)) this.userSettings.updateNotifications({cooldownSeconds: seconds});
    }

    protected clearCustom(key: SoundKey): void {
        this.soundSettings.update(key, {customUrl: undefined, customName: undefined});
    }

    protected updateVolume(key: SoundKey, pct: number): void {
        this.soundSettings.update(key, {volume: pct / 100});
    }

    protected getVolumePct(key: SoundKey): number {
        return Math.round(this.soundSettings.settings()[key].volume * 100);
    }
}
