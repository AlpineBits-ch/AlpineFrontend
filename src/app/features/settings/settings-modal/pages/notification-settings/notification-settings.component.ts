import {ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {UserSettingsService} from '../../../../../services/user-settings.service';
import {SoundKey, SoundSettingsService} from '../../../../../services/sound-settings.service';
import {NotificationService} from '../../../../../services/notification.service';
import {PlatformCapabilities} from '../../../../../platform/capabilities';
import {GuildService} from '../../../../../services/guild.service';

@Component({
    selector: 'app-notification-settings',
    imports: [ToggleSwitch, FormsModule, TranslateModule],
    templateUrl: './notification-settings.component.html',
    styleUrl: './notification-settings.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationSettingsComponent {
    protected readonly userSettings = inject(UserSettingsService);
    protected readonly soundSettings = inject(SoundSettingsService);

    /** Whether the host has durably refused to show notifications. */
    protected readonly notifications = inject(NotificationService);

    /** Read for `backgroundPush`, and deliberately not for `nativeToasts`. */
    protected readonly capabilities = inject(PlatformCapabilities);

    /** Source for the per-guild go-live toggles below - every guild this account is in, whether or
     *  not its notifications are currently switched on. */
    protected readonly guilds = inject(GuildService).guilds;

    protected readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
    protected readonly uploadError = signal('');
    protected readonly soundItems: {key: SoundKey; label: string; description: string}[] = [
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

    protected isGoLiveEnabled(guildId: string): boolean {
        return this.userSettings.notificationSettings().goLiveGuildIds.includes(guildId);
    }

    protected setGoLiveEnabled(guildId: string, enabled: boolean): void {
        this.userSettings.setGoLiveNotifyEnabled(guildId, enabled);
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
