import {TestBed} from '@angular/core/testing';
import {TranslateModule} from '@ngx-translate/core';
import {InstancePickerComponent, normalizeDomain} from './instance-picker.component';

function setup(domain = 'venta.gg', recents: string[] = []) {
    TestBed.configureTestingModule({imports: [InstancePickerComponent, TranslateModule.forRoot()]});

    const fixture = TestBed.createComponent(InstancePickerComponent);
    fixture.componentRef.setInput('domain', domain);
    fixture.componentRef.setInput('recents', recents);
    fixture.detectChanges();

    return fixture;
}

/** The template members are protected, which is a compile-time rule rather than a runtime one. */
function inner(fixture: ReturnType<typeof setup>) {
    return fixture.componentInstance as unknown as {
        options: () => {label: string; value: string}[];
        choose: (domain: string) => void;
        startAdd: (select: {hide: () => void}) => void;
        confirmAdd: () => void;
        cancelAdd: () => void;
        adding: () => boolean;
        draft: string;
    };
}

function values(fixture: ReturnType<typeof setup>): string[] {
    return inner(fixture)
        .options()
        .map(o => o.value);
}

describe('InstancePickerComponent options', () => {
    it('pins the home instance first when nothing has been signed in to', () => {
        expect(values(setup())).toEqual(['venta.gg']);
    });

    it('lists signed-in instances under the home one', () => {
        const fixture = setup('venta.gg', ['rp.thornwood.net', 'chat.kestrel.dev']);

        expect(values(fixture)).toEqual(['venta.gg', 'rp.thornwood.net', 'chat.kestrel.dev']);
    });

    it('does not repeat the home instance when a slot is on it', () => {
        const fixture = setup('venta.gg', ['venta.gg', 'rp.thornwood.net']);

        expect(values(fixture)).toEqual(['venta.gg', 'rp.thornwood.net']);
    });

    it('caps the recents so the panel cannot grow without bound', () => {
        const fixture = setup('venta.gg', ['a.example', 'b.example', 'c.example', 'd.example']);

        expect(values(fixture)).toEqual(['venta.gg', 'a.example', 'b.example', 'c.example']);
    });

    // A p-select whose value is missing from its options renders blank.
    it('includes the selected instance even when it is not a recent', () => {
        const fixture = setup('typed.example', ['a.example']);

        expect(values(fixture)).toContain('typed.example');
    });
});

describe('InstancePickerComponent adding', () => {
    const select = {hide: () => {}};

    it('closes the panel when the add row is taken', () => {
        const fixture = setup();
        const hide = vi.fn();

        inner(fixture).startAdd({hide});

        expect(hide).toHaveBeenCalled();
        expect(inner(fixture).adding()).toBe(true);
    });

    it('emits the typed instance and leaves the add row', () => {
        const fixture = setup();
        const emitted: string[] = [];
        fixture.componentInstance.domain.subscribe(d => emitted.push(d));

        inner(fixture).startAdd(select);
        inner(fixture).draft = 'rp.thornwood.net';
        inner(fixture).confirmAdd();

        expect(emitted).toEqual(['rp.thornwood.net']);
        expect(inner(fixture).adding()).toBe(false);
    });

    it('ignores an empty value rather than selecting nothing', () => {
        const fixture = setup();
        const emitted: string[] = [];
        fixture.componentInstance.domain.subscribe(d => emitted.push(d));

        inner(fixture).startAdd(select);
        inner(fixture).draft = '   ';
        inner(fixture).confirmAdd();

        expect(emitted).toEqual([]);
        expect(inner(fixture).adding()).toBe(true);
    });

    it('keeps the previous instance when the add is cancelled', () => {
        const fixture = setup('venta.gg');
        const emitted: string[] = [];
        fixture.componentInstance.domain.subscribe(d => emitted.push(d));

        inner(fixture).startAdd(select);
        inner(fixture).draft = 'rp.thornwood.net';
        inner(fixture).cancelAdd();

        expect(emitted).toEqual([]);
    });
});

describe('normalizeDomain', () => {
    it('takes a domain as typed', () => {
        expect(normalizeDomain('rp.thornwood.net')).toBe('rp.thornwood.net');
    });

    it('accepts a pasted URL', () => {
        expect(normalizeDomain('https://rp.thornwood.net/')).toBe('rp.thornwood.net');
    });

    it('accepts http and stray whitespace', () => {
        expect(normalizeDomain('  http://self.example:8443  ')).toBe('self.example:8443');
    });

    it('answers empty for a blank value', () => {
        expect(normalizeDomain('   ')).toBe('');
    });
});
