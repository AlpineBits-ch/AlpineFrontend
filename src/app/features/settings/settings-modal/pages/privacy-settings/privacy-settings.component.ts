import {Component, computed, inject, OnInit, signal} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {RadioButton} from 'primeng/radiobutton';
import {Select} from 'primeng/select';
import {InputNumber} from 'primeng/inputnumber';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {HttpErrorResponse} from '@angular/common/http';
import {PrivacySettingsService} from '../../../../../services/privacy-settings.service';
import {ToastService} from '../../../../../services/toast.service';
import {
    DirectMessagePolicy,
    DM_RETENTION_MAX_DAYS,
    DM_RETENTION_MIN_DAYS,
    ExplicitContentFilter,
    FriendRequestPolicy,
    PrivacySettings,
    Visibility,
} from '../../../../../models/privacy-settings.model';
import {BlockedUsersComponent} from './blocked-users/blocked-users.component';
import {DataExportComponent} from './data-export/data-export.component';
import {GuildDmOverridesComponent} from './guild-dm-overrides/guild-dm-overrides.component';

/** The boolean members of the record - the ones a toggle row can drive. */
type BooleanKey = {
    [K in keyof PrivacySettings]: PrivacySettings[K] extends boolean ? K : never
}[keyof PrivacySettings];

interface ToggleRow {
    key: BooleanKey;
    labelKey: string;
    descKey: string;
}

interface ChoiceOption<T> {
    value: T;
    labelKey: string;
    descKey: string;
}

interface VisibilityRow {
    key: 'mutualServersVisibility' | 'mutualFriendsVisibility' | 'connectionsVisibility' | 'birthdayVisibility';
    labelKey: string;
}

/** The account's privacy controls. */
@Component({
    selector: 'app-privacy-settings',
    imports: [
        ToggleSwitch,
        RadioButton,
        Select,
        InputNumber,
        FormsModule,
        TranslateModule,
        BlockedUsersComponent,
        DataExportComponent,
        GuildDmOverridesComponent,
    ],
    templateUrl: './privacy-settings.component.html',
    styleUrl: './privacy-settings.component.css',
})
export class PrivacySettingsComponent implements OnInit {
    protected readonly privacy = inject(PrivacySettingsService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly settings = this.privacy.settings;
    protected readonly disabled = computed(() => !this.privacy.isReady());
    protected readonly unavailable = computed(() => this.privacy.status() === 'unavailable');

    /** Retention is edited as a number box that is only live once the user opts in. */
    protected readonly retentionEnabled = signal(false);
    protected readonly retentionMin = DM_RETENTION_MIN_DAYS;
    protected readonly retentionMax = DM_RETENTION_MAX_DAYS;

    protected readonly consentToggles: ToggleRow[] = [
        {
            key: 'allowDataCollection',
            labelKey: 'SETTINGS.PRIVACY.CONSENT_DATA_COLLECTION',
            descKey: 'SETTINGS.PRIVACY.CONSENT_DATA_COLLECTION_DESC',
        },
        {
            key: 'allowPersonalization',
            labelKey: 'SETTINGS.PRIVACY.CONSENT_PERSONALIZATION',
            descKey: 'SETTINGS.PRIVACY.CONSENT_PERSONALIZATION_DESC',
        },
        {
            key: 'allowVoiceRecordingInClips',
            labelKey: 'SETTINGS.PRIVACY.CONSENT_VOICE_CLIPS',
            descKey: 'SETTINGS.PRIVACY.CONSENT_VOICE_CLIPS_DESC',
        },
    ];

    protected readonly discoverabilityToggles: ToggleRow[] = [
        {
            key: 'discoverableByUsername',
            labelKey: 'SETTINGS.PRIVACY.DISCOVER_USERNAME',
            descKey: 'SETTINGS.PRIVACY.DISCOVER_USERNAME_DESC',
        },
        {
            key: 'discoverableByEmail',
            labelKey: 'SETTINGS.PRIVACY.DISCOVER_EMAIL',
            descKey: 'SETTINGS.PRIVACY.DISCOVER_EMAIL_DESC',
        },
        {
            key: 'discoverableByPhone',
            labelKey: 'SETTINGS.PRIVACY.DISCOVER_PHONE',
            descKey: 'SETTINGS.PRIVACY.DISCOVER_PHONE_DESC',
        },
    ];

    protected readonly presenceToggles: ToggleRow[] = [
        {
            key: 'shareActivity',
            labelKey: 'SETTINGS.PRIVACY.SHARE_ACTIVITY',
            descKey: 'SETTINGS.PRIVACY.SHARE_ACTIVITY_DESC',
        },
        {
            key: 'allowPositionalVoiceCapture',
            labelKey: 'SETTINGS.PRIVACY.POSITIONAL_VOICE',
            descKey: 'SETTINGS.PRIVACY.POSITIONAL_VOICE_DESC',
        },
    ];

    protected readonly messagingToggles: ToggleRow[] = [
        {
            key: 'sendReadReceipts',
            labelKey: 'SETTINGS.PRIVACY.READ_RECEIPTS',
            descKey: 'SETTINGS.PRIVACY.READ_RECEIPTS_DESC',
        },
        {
            key: 'sendTypingIndicators',
            labelKey: 'SETTINGS.PRIVACY.TYPING_INDICATORS',
            descKey: 'SETTINGS.PRIVACY.TYPING_INDICATORS_DESC',
        },
    ];

    protected readonly pushToggles: ToggleRow[] = [
        {
            key: 'hidePushContent',
            labelKey: 'SETTINGS.PRIVACY.HIDE_PUSH_CONTENT',
            descKey: 'SETTINGS.PRIVACY.HIDE_PUSH_CONTENT_DESC',
        },
    ];

    protected readonly directMessageOptions: ChoiceOption<DirectMessagePolicy>[] = [
        {
            value: DirectMessagePolicy.Everyone,
            labelKey: 'SETTINGS.PRIVACY.DM_EVERYONE',
            descKey: 'SETTINGS.PRIVACY.DM_EVERYONE_DESC',
        },
        {
            value: DirectMessagePolicy.FriendsAndServerMembers,
            labelKey: 'SETTINGS.PRIVACY.DM_FRIENDS_AND_MEMBERS',
            descKey: 'SETTINGS.PRIVACY.DM_FRIENDS_AND_MEMBERS_DESC',
        },
        {
            value: DirectMessagePolicy.Friends,
            labelKey: 'SETTINGS.PRIVACY.DM_FRIENDS',
            descKey: 'SETTINGS.PRIVACY.DM_FRIENDS_DESC',
        },
        {
            value: DirectMessagePolicy.Nobody,
            labelKey: 'SETTINGS.PRIVACY.DM_NOBODY',
            descKey: 'SETTINGS.PRIVACY.DM_NOBODY_DESC',
        },
    ];

    protected readonly friendRequestOptions: ChoiceOption<FriendRequestPolicy>[] = [
        {
            value: FriendRequestPolicy.Everyone,
            labelKey: 'SETTINGS.PRIVACY.FR_EVERYONE',
            descKey: 'SETTINGS.PRIVACY.FR_EVERYONE_DESC',
        },
        {
            value: FriendRequestPolicy.FriendsOfFriends,
            labelKey: 'SETTINGS.PRIVACY.FR_FRIENDS_OF_FRIENDS',
            descKey: 'SETTINGS.PRIVACY.FR_FRIENDS_OF_FRIENDS_DESC',
        },
        {
            value: FriendRequestPolicy.ServerMembers,
            labelKey: 'SETTINGS.PRIVACY.FR_SERVER_MEMBERS',
            descKey: 'SETTINGS.PRIVACY.FR_SERVER_MEMBERS_DESC',
        },
        {
            value: FriendRequestPolicy.Nobody,
            labelKey: 'SETTINGS.PRIVACY.FR_NOBODY',
            descKey: 'SETTINGS.PRIVACY.FR_NOBODY_DESC',
        },
    ];

    protected readonly visibilityRows: VisibilityRow[] = [
        {key: 'mutualServersVisibility', labelKey: 'SETTINGS.PRIVACY.VIS_MUTUAL_SERVERS'},
        {key: 'mutualFriendsVisibility', labelKey: 'SETTINGS.PRIVACY.VIS_MUTUAL_FRIENDS'},
        {key: 'connectionsVisibility', labelKey: 'SETTINGS.PRIVACY.VIS_CONNECTIONS'},
        {key: 'birthdayVisibility', labelKey: 'SETTINGS.PRIVACY.VIS_BIRTHDAY'},
    ];

    protected readonly visibilityOptions = [
        {value: Visibility.Everyone, labelKey: 'SETTINGS.PRIVACY.VIS_OPT_EVERYONE'},
        {value: Visibility.Friends, labelKey: 'SETTINGS.PRIVACY.VIS_OPT_FRIENDS'},
        {value: Visibility.Nobody, labelKey: 'SETTINGS.PRIVACY.VIS_OPT_NOBODY'},
    ];

    protected readonly explicitFilterOptions = [
        {value: ExplicitContentFilter.Off, labelKey: 'SETTINGS.PRIVACY.FILTER_OFF'},
        {value: ExplicitContentFilter.UnknownSenders, labelKey: 'SETTINGS.PRIVACY.FILTER_UNKNOWN'},
        {value: ExplicitContentFilter.Everyone, labelKey: 'SETTINGS.PRIVACY.FILTER_EVERYONE'},
    ];

    ngOnInit(): void {
        this.privacy.ensureLoaded();
        this.retentionEnabled.set(this.settings().dmRetentionDays !== null);
    }

    /** True when the server refused this field under the minor floor (T1-11). */
    protected isRestricted(key: keyof PrivacySettings): boolean {
        return this.privacy.minorRestricted().has(key);
    }

    protected isDisabled(key: keyof PrivacySettings): boolean {
        return this.disabled() || this.isRestricted(key);
    }

    protected write<K extends keyof PrivacySettings>(key: K, value: PrivacySettings[K]): void {
        if (this.settings()[key] === value) return;
        this.privacy.patch({[key]: value}).subscribe({
            error: (err: HttpErrorResponse) => this.reportFailure(err),
        });
    }

    protected onRetentionToggle(enabled: boolean): void {
        this.retentionEnabled.set(enabled);
        // null is not an omission here - it is the meaningful "keep forever", and the endpoint
        // reads it as a real value rather than skipping the field.
        this.write('dmRetentionDays', enabled ? 30 : null);
    }

    /** Writes a retention window, refusing values the server would 400 on. */
    protected onRetentionDays(days: number | null): void {
        if (days === null || !Number.isFinite(days)) return;
        const clamped = Math.min(Math.max(Math.round(days), DM_RETENTION_MIN_DAYS), DM_RETENTION_MAX_DAYS);
        this.write('dmRetentionDays', clamped);
    }

    /**
     * Surfaces a failed write. The service has already rolled the local copy back, so the control
     * springs to its previous position; this says why.
     */
    private reportFailure(err: HttpErrorResponse): void {
        const key = this.privacy.minorRestricted().size > 0 && err.status === 403
            ? 'SETTINGS.PRIVACY.ERROR_MINOR_RESTRICTED'
            : 'SETTINGS.PRIVACY.ERROR_SAVE';
        this.toast.error(this.translate.instant(key));
    }
}
