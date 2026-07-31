import {formatAloneNotice} from './alone-countdown';

it('names the time the call will end', () => {
    const deadline = new Date('2026-07-31T14:35:00Z');
    const expected = deadline.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

    expect(formatAloneNotice(deadline)).toBe(
        `Waiting for others to rejoin - call ends at ${expected}`,
    );
});

it('has nothing to say when no deadline applies', () => {
    expect(formatAloneNotice(null)).toBeNull();
});

it('ignores an unparseable deadline rather than rendering "Invalid Date"', () => {
    expect(formatAloneNotice(new Date('nonsense'))).toBeNull();
});
