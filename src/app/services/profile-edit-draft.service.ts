import {computed, Injectable, signal} from '@angular/core';
import {ProfileDto, ProfileFont} from '../dtos/response/profile.dto';

export interface ProfileEditFields {
    profileId: string;
    bio: string;
    accentColor: string;
    font: ProfileFont;
}

function fieldsOf(profile: ProfileDto): ProfileEditFields {
    return {
        profileId: profile.id,
        bio: profile.bio ?? '',
        accentColor: profile.accentColor ?? '',
        font: profile.font,
    };
}

/**
 * The unsaved bio/accent/font edit, held outside the page component so it survives
 * navigating away and back, the same way CanvasEditorService's draft does.
 */
@Injectable({providedIn: 'root'})
export class ProfileEditDraftService {
    private readonly baseline = signal<ProfileEditFields | null>(null);
    private readonly current = signal<ProfileEditFields | null>(null);

    readonly draft = this.current.asReadonly();

    readonly dirty = computed(() => {
        const current = this.current();
        const baseline = this.baseline();
        return !!current && !!baseline && JSON.stringify(current) !== JSON.stringify(baseline);
    });

    begin(profile: ProfileDto): void {
        const fields = fieldsOf(profile);
        this.current.set(fields);
        this.baseline.set(fields);
    }

    discard(): void {
        const baseline = this.baseline();
        if (baseline) this.current.set(baseline);
    }

    setBio(bio: string): void {
        const current = this.current();
        if (current) this.current.set({...current, bio});
    }

    setAccentColor(accentColor: string): void {
        const current = this.current();
        if (current) this.current.set({...current, accentColor});
    }

    setFont(font: ProfileFont): void {
        const current = this.current();
        if (current) this.current.set({...current, font});
    }
}
