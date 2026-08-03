import {ChangeDetectionStrategy, Component, computed, effect, inject, input, OnInit, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpErrorResponse} from '@angular/common/http';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {QuietHoursDto} from '../../../../../../dtos/response/quiet-hours.dto';
import {QuietHoursApiService} from '../../../../../../services/quiet-hours-api.service';
import {ToastService} from '../../../../../../services/toast.service';
import {
    browserTimeZoneId,
    formatMinuteOfDay,
    isValidTimeZoneId,
    isWithinQuietHours,
    parseMinuteOfDay,
    QuietHoursError,
    validateQuietHours,
    windowLengthMinutes,
} from '../../../../quiet-hours';

/** 22:00, the start most households actually want. */
const DEFAULT_START = 22 * 60;
/** 07:00. Together with the default start this is a wrapped window, which is the point. */
const DEFAULT_END = 7 * 60;

@Component({
    selector: 'app-quiet-hours-settings',
    imports: [FormsModule, Button, InputText, ToggleSwitch, TranslateModule],
    templateUrl: './quiet-hours-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuietHoursSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    /** Lets the modal shell guard nav-away and close while edits are pending. */
    dirtyChange = output<boolean>();

    protected loading = signal(true);
    protected saving = signal(false);
    /** `403` on the read: far more likely the module is off than a permission problem. */
    protected unavailable = signal(false);

    protected enabled = signal(false);
    protected startTime = signal(formatMinuteOfDay(DEFAULT_START));
    protected endTime = signal(formatMinuteOfDay(DEFAULT_END));
    protected timeZoneId = signal(browserTimeZoneId());

    /** Recomputed every minute so "currently quiet" does not sit wrong for an hour. */
    private nowTick = signal(Date.now());

    private api = inject(QuietHoursApiService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    /**
     * The last state the server confirmed. A signal, not a field: after a save the form's own
     * values are unchanged, so a plain field would leave `dirty` stuck on its cached `true`.
     */
    private saved = signal<QuietHoursDto | null>(null);

    protected draft = computed<QuietHoursDto>(() => ({
        enabled: this.enabled(),
        startMinuteLocal: parseMinuteOfDay(this.startTime()) ?? -1,
        endMinuteLocal: parseMinuteOfDay(this.endTime()) ?? -1,
        timeZoneId: this.timeZoneId().trim(),
    }));

    protected error = computed<QuietHoursError | null>(() => validateQuietHours(this.draft()));

    protected timeZoneUnknown = computed(() => !isValidTimeZoneId(this.timeZoneId().trim()));

    /**
     * True whenever `start > end`. Surfaced rather than hidden: a household setting 22:00 → 07:00
     * should see the app agree that this means "overnight", not silently treat it as an error.
     */
    protected wrapsMidnight = computed(() => {
        const {startMinuteLocal, endMinuteLocal} = this.draft();
        return startMinuteLocal >= 0 && endMinuteLocal >= 0 && startMinuteLocal > endMinuteLocal;
    });

    protected lengthLabel = computed(() => {
        const {startMinuteLocal, endMinuteLocal} = this.draft();
        if (startMinuteLocal < 0 || endMinuteLocal < 0) return '';
        const minutes = windowLengthMinutes(startMinuteLocal, endMinuteLocal);
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest ? `${hours}h ${rest}m` : `${hours}h`;
    });

    /** Whether the guild is inside its window *right now*, wrap included. */
    protected currentlyQuiet = computed(() => {
        this.nowTick();
        return this.error() === null && isWithinQuietHours(this.draft());
    });

    protected dirty = computed(() => {
        const saved = this.saved();
        if (!saved) return false;
        const d = this.draft();
        return saved.enabled !== d.enabled
            || saved.startMinuteLocal !== d.startMinuteLocal
            || saved.endMinuteLocal !== d.endMinuteLocal
            || saved.timeZoneId !== d.timeZoneId;
    });

    constructor() {
        effect(() => this.dirtyChange.emit(this.dirty()));
        const timer = setInterval(() => this.nowTick.set(Date.now()), 60_000);
        // No DestroyRef ceremony beyond this: one interval, one page, cleared when it goes away.
        effect(onCleanup => onCleanup(() => clearInterval(timer)));
    }

    ngOnInit(): void {
        this.api.get(this.guild().id).subscribe({
            next: cfg => {
                this.applyLoaded(cfg);
                this.loading.set(false);
            },
            error: (err: HttpErrorResponse) => {
                this.loading.set(false);
                if (err.status === 403) {
                    // Renders nothing rather than a denial - "your house doesn't do this" is not
                    // "you're not allowed", and from here the two are the same response.
                    this.unavailable.set(true);
                    return;
                }
                if (err.status === 404) {
                    // Never configured. The defaults below are a sensible overnight window rather
                    // than a blank form nobody knows how to fill in.
                    this.applyLoaded({
                        enabled: false,
                        startMinuteLocal: DEFAULT_START,
                        endMinuteLocal: DEFAULT_END,
                        timeZoneId: browserTimeZoneId(),
                    });
                    return;
                }
                this.toast.httpError(this.translate.instant('QUIET_HOURS.LOAD_ERROR'), err);
            },
        });
    }

    protected useBrowserTimeZone(): void {
        this.timeZoneId.set(browserTimeZoneId());
    }

    protected save(): void {
        if (this.saving()) return;
        const invalid = this.error();
        if (invalid) {
            this.toast.error(this.translate.instant(`QUIET_HOURS.ERROR.${invalid}`));
            return;
        }
        this.saving.set(true);
        const config = this.draft();
        this.api.put(this.guild().id, config).subscribe({
            next: cfg => {
                this.saving.set(false);
                // The server's echo wins: it is what a later GET will return.
                this.applyLoaded(cfg ?? config);
                this.toast.success(this.translate.instant('QUIET_HOURS.SAVE_SUCCESS'));
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('QUIET_HOURS.SAVE_ERROR'), err);
            },
        });
    }

    private applyLoaded(cfg: QuietHoursDto): void {
        this.enabled.set(!!cfg.enabled);
        this.startTime.set(formatMinuteOfDay(cfg.startMinuteLocal ?? DEFAULT_START));
        this.endTime.set(formatMinuteOfDay(cfg.endMinuteLocal ?? DEFAULT_END));
        // An empty or unknown zone on the row would leave the form unsaveable with no clue why;
        // defaulting to the browser's is both valid and almost always what they meant.
        this.timeZoneId.set(isValidTimeZoneId(cfg.timeZoneId) ? cfg.timeZoneId : browserTimeZoneId());
        this.saved.set(this.draft());
    }
}
