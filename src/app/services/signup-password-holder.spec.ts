import {TestBed} from '@angular/core/testing';
import {NavigationEnd, Router} from '@angular/router';
import {Subject} from 'rxjs';
import {SignupPasswordHolder} from './signup-password-holder';

function setup() {
    const events = new Subject<NavigationEnd>();
    TestBed.configureTestingModule({
        providers: [{provide: Router, useValue: {events}}],
    });
    return {holder: TestBed.inject(SignupPasswordHolder), events};
}

function navigateTo(events: Subject<NavigationEnd>, url: string): void {
    events.next(new NavigationEnd(1, url, url));
}

describe('SignupPasswordHolder', () => {
    it('hands back the password it was given', () => {
        const {holder} = setup();
        holder.set('hunter2');
        expect(holder.take()).toBe('hunter2');
    });

    it('keeps nothing after a take', () => {
        const {holder} = setup();
        holder.set('hunter2');
        holder.take();
        expect(holder.take()).toBeNull();
    });

    // owedSteps() is a computed and reads this on every recomputation.
    it('does not consume on has()', () => {
        const {holder} = setup();
        holder.set('hunter2');
        expect(holder.has()).toBe(true);
        expect(holder.has()).toBe(true);
        expect(holder.take()).toBe('hunter2');
    });

    it('drops the password on the way back to the login screen', () => {
        const {holder, events} = setup();
        holder.set('hunter2');
        navigateTo(events, '/authentication');
        expect(holder.has()).toBe(false);
    });

    it('survives navigation inside the app', () => {
        const {holder, events} = setup();
        holder.set('hunter2');
        navigateTo(events, '/overview');
        expect(holder.has()).toBe(true);
    });
});
