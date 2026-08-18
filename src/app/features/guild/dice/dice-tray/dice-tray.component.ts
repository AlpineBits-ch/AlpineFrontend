import {
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {DiceFaceComponent} from '../dice-face/dice-face.component';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
import {DiceService} from '../../../../services/dice.service';
import {ToastService} from '../../../../services/toast.service';
import {DieFace} from '../dice-roll-view';
import {PersonaIdentity} from '../../personas/persona-identity';
import {DiceTermSpec, keptCount, parseDiceExpression} from '../dice-notation';

/** What the picker offers before this channel has any history of its own. */
const STARTERS: readonly string[] = ['d20', '1d20adv', '2d6', '4d6kh3', '1d100'];

/** A preview shape: how many dice of what size, and how many of them will count. */
interface PreviewPool {
    sides: number;
    faces: DieFace[];
    sign: 1 | -1;
}

/**
 * Where a roll is written. An expression is notation, so it is typed in the monospace face and
 * previewed as the dice it will produce, which is how somebody learns the notation without a guide.
 */
@Component({
    selector: 'app-dice-tray',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, TranslateModule, DiceFaceComponent, PersonaAvatarComponent],
    templateUrl: './dice-tray.component.html',
    styleUrl: './dice-tray.component.css',
})
export class DiceTrayComponent {
    readonly guildId = input.required<string>();
    readonly channelId = input.required<string>();
    /** Who the composer would speak as. A roll in character reuses that answer rather than asking. */
    readonly speaker = input<PersonaIdentity | null>(null);
    readonly personaId = input<string | null>(null);
    readonly closed = output<void>();

    private readonly dice = inject(DiceService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    private readonly inputRef = viewChild<ElementRef<HTMLInputElement>>('expressionInput');

    protected readonly expression = signal('');
    protected readonly reason = signal('');
    protected readonly rolling = signal(false);

    protected readonly parsed = computed(() => parseDiceExpression(this.expression()));

    /** Nothing typed yet is not an error, so the bad-notation line stays quiet until it is. */
    protected readonly error = computed(() => {
        if (!this.expression().trim()) return null;
        const parsed = this.parsed();
        return parsed.ok ? null : parsed;
    });

    protected readonly canRoll = computed(() => !this.rolling() && this.parsed().ok);

    /** The dice this expression will produce, as outlines. Dimmed ones are the keep or drop loss. */
    protected readonly preview = computed((): PreviewPool[] => {
        const parsed = this.parsed();
        if (!parsed.ok) return [];
        return parsed.value.terms.filter(term => term.constant === null).map(poolPreview);
    });

    protected readonly constants = computed(() => {
        const parsed = this.parsed();
        if (!parsed.ok) return [];
        return parsed.value.terms.filter(term => term.constant !== null);
    });

    /** This channel's own history first, then a handful of starters it does not already hold. */
    protected readonly suggestions = computed(() => {
        const recent = this.dice.recent(this.channelId());
        return [...recent, ...STARTERS.filter(s => !recent.includes(s))].slice(0, 6);
    });

    constructor() {
        queueMicrotask(() => this.inputRef()?.nativeElement.focus());
    }

    protected use(expression: string): void {
        this.expression.set(expression);
        this.inputRef()?.nativeElement.focus();
    }

    protected onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.closed.emit();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            this.roll();
        }
    }

    protected roll(): void {
        if (!this.canRoll()) return;
        this.rolling.set(true);
        this.dice
            .roll(this.guildId(), this.channelId(), {
                expression: this.expression().trim(),
                personaId: this.personaId(),
                reason: this.reason().trim() || null,
            })
            .subscribe({
                next: () => {
                    this.rolling.set(false);
                    this.closed.emit();
                },
                error: err => {
                    this.rolling.set(false);
                    this.toast.httpError(this.translate.instant('DICE.TRAY.FAILED'), err);
                },
            });
    }
}

function poolPreview(term: DiceTermSpec): PreviewPool {
    const counting = keptCount(term);
    return {
        sides: term.sides,
        sign: term.sign,
        faces: Array.from({length: term.count}, (_, index) => ({
            value: 0,
            kept: index < counting,
            isMax: false,
            isMin: false,
            exploded: false,
        })),
    };
}
