import {Directive, HostBinding, input} from '@angular/core';
import {userNameStyle, UserNameStyleInput} from '../models/profile-font.model';

@Directive({
    selector: '[appUserNameStyle]',
})
export class UserNameStyleDirective {
    appUserNameStyle = input<UserNameStyleInput | null | undefined>(null);

    @HostBinding('style.color')
    protected get color(): string | undefined {
        return userNameStyle(this.appUserNameStyle()).color;
    }

    @HostBinding('style.fontFamily')
    protected get fontFamily(): string | undefined {
        return userNameStyle(this.appUserNameStyle()).fontFamily;
    }
}
