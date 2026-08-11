import {formatAloneDeadline} from './alone-countdown';

it('names the time the call will end', () => {
    const deadline = new Date('2026-07-31T14:35:00Z');
    const expected = deadline.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

    expect(formatAloneDeadline(deadline)).toBe(expected);
});

it('returns the time alone, so the sentence around it can be translated', () => {
    // The whole point of the change: this used to bake an English sentence around the time, which
    // made the one banner with something interesting to say the one that could never be localised.
    const formatted = formatAloneDeadline(new Date('2026-07-31T14:35:00Z'));

    expect(formatted).not.toMatch(/call ends|waiting/i);
});

it('has nothing to say when no deadline applies', () => {
    expect(formatAloneDeadline(null)).toBeNull();
});

it('ignores an unparseable deadline rather than rendering "Invalid Date"', () => {
    expect(formatAloneDeadline(new Date('nonsense'))).toBeNull();
});
