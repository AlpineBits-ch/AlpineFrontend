import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    OnInit,
    output,
    signal,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpErrorResponse} from '@angular/common/http';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
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

/** Every zone this runtime knows, so nobody has to spell `Europe/Zurich` from memory. Feature-detected rather than assumed: some runtimes are missing `Intl.supportedValuesOf`, and an empty list here is what makes the page fall back to the free-text field; either way `isValidTimeZoneId` decides whether the id is usable. */
function supportedTimeZoneIds(): string[] {
    if (typeof (Intl as {supportedValuesOf?: unknown}).supportedValuesOf !== 'function') return [];
    try {
        return Intl.supportedValuesOf('timeZone');
    } catch {
        return [];
    }
}

@Component({
    selector: 'app-quiet-hours-settings',
    imports: [FormsModule, Button, InputText, Select, ToggleSwitch, TranslateModule],
    templateUrl: './quiet-hours-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuietHoursSettingsComponent implements OnInit {
    readonly guild = input.required<GuildDto>();
    /** Lets the modal shell guard nav-away and close while edits are pending. */
    dirtyChange = output<boolean>();

    protected readonly loading = signal(true);
    protected readonly saving = signal(false);
    /** `403` on the read: far more likely the module is off than a permission problem. */
    protected readonly unavailable = signal(false);

    protected readonly enabled = signal(false);
    protected readonly startTime = signal(formatMinuteOfDay(DEFAULT_START));
    protected readonly endTime = signal(formatMinuteOfDay(DEFAULT_END));
    protected readonly timeZoneId = signal(browserTimeZoneId());

    private baseTimeZoneOptions = supportedTimeZoneIds().map(id => ({label: id, value: id}));
    /** False on a runtime with no zone list, where the template keeps the old free-text field. */
    protected timeZonePickerAvailable = this.baseTimeZoneOptions.length > 0;

    /** The zone list, with the current id folded in when the platform does not list it: a saved zone can be an alias this runtime resolves but never enumerates (`Asia/Calcutta` for `Asia/Kolkata`), and without this the picker would render blank over a valid value and the first click would silently change it. */
    protected readonly timeZoneOptions = computed(() => {
        const current = this.timeZoneId().trim();
        if (!current || this.baseTimeZoneOptions.some(o => o.value === current))
            return this.baseTimeZoneOptions;
        return [{label: current, value: current}, ...this.baseTimeZoneOptions];
    });

    /** Recomputed every minute so "currently quiet" does not sit wrong for an hour. */
    private readonly nowTick = signal(Date.now());

    private api = inject(QuietHoursApiService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    /** The last state the server confirmed. A signal, not a field: after a save the form's own values are unchanged, so a plain field would leave `dirty` stuck on its cached `true`. */
    private readonly saved = signal<QuietHoursDto | null>(null);

    protected readonly draft = computed<QuietHoursDto>(() => ({
        enabled: this.enabled(),
        startMinuteLocal: parseMinuteOfDay(this.startTime()) ?? -1,
        endMinuteLocal: parseMinuteOfDay(this.endTime()) ?? -1,
        timeZoneId: this.timeZoneId().trim(),
    }));

    protected readonly error = computed<QuietHoursError | null>(() => validateQuietHours(this.draft()));

    protected readonly timeZoneUnknown = computed(() => !isValidTimeZoneId(this.timeZoneId().trim()));

    /** The window's own validation error, shown under the times. `UNKNOWN_TIME_ZONE` is dropped since the zone field reports itself independently: `validateQuietHours` returns the first error only, so a cleared start time would otherwise hide a bad zone. */
    protected readonly windowError = computed(() => {
        const err = this.error();
        return err === 'UNKNOWN_TIME_ZONE' ? null : err;
    });

    /** True whenever `start > end`. Surfaced rather than hidden: a household setting 22:00 → 07:00 should see the app agree that this means "overnight", not silently treat it as an error. */
    protected readonly wrapsMidnight = computed(() => {
        const {startMinuteLocal, endMinuteLocal} = this.draft();
        return startMinuteLocal >= 0 && endMinuteLocal >= 0 && startMinuteLocal > endMinuteLocal;
    });

    protected readonly lengthLabel = computed(() => {
        const {startMinuteLocal, endMinuteLocal} = this.draft();
        if (startMinuteLocal < 0 || endMinuteLocal < 0) return '';
        const minutes = windowLengthMinutes(startMinuteLocal, endMinuteLocal);
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest ? `${hours}h ${rest}m` : `${hours}h`;
    });

    /** Whether the guild is inside its window *right now*, wrap included. */
    protected readonly currentlyQuiet = computed(() => {
        this.nowTick();
        return this.error() === null && isWithinQuietHours(this.draft());
    });

    protected readonly dirty = computed(() => {
        const saved = this.saved();
        if (!saved) return false;
        const d = this.draft();
        return (
            saved.enabled !== d.enabled ||
            saved.startMinuteLocal !== d.startMinuteLocal ||
            saved.endMinuteLocal !== d.endMinuteLocal ||
            saved.timeZoneId !== d.timeZoneId
        );
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
                    // Says the feature is not available rather than that access was denied: "your house doesn't do this" is not "you're not allowed", and from here the two are the same response, so the wording has to cover both.
                    this.unavailable.set(true);
                    return;
                }
                if (err.status === 404) {
                    // Never configured; the defaults below are a sensible overnight window rather than a blank form nobody knows how to fill in.
                    this.applyLoaded({
                        enabled: false,
                        startMinuteLocal: DEFAULT_START,
                        endMinuteLocal: DEFAULT_END,
                        timeZoneId: browserTimeZoneId(),
                    });
                    return;
                }
                this.toast.httpError(this.translate.instant('QUIET_HOURS.LOAD_ERROR'), err);
                // The form is still usable after a failed read, so what is on screen becomes the baseline; without one, `dirty` never flips and Save stays disabled forever.
                this.saved.set(this.draft());
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
        // An empty or unknown zone on the row would leave the form unsaveable with no clue why; defaulting to the browser's is both valid and almost always what they meant.
        this.timeZoneId.set(isValidTimeZoneId(cfg.timeZoneId) ? cfg.timeZoneId : browserTimeZoneId());
        this.saved.set(this.draft());
    }
}
