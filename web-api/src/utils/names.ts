// The one rule for usernames and display names, used by every path that
// sets one (registration, profile update, in-game and Mix renames). Names
// are what players find each other by and what moderation acts on, so the
// rule keeps them readable and unambiguous:
//   - NFKC-folded and trimmed first; every check runs on the stored value
//     (folding turns fullwidth or math letters into plain ones and can
//     lengthen a name)
//   - 3 to 20 characters
//   - letters, digits 0-9, single spaces, "_", "-" and "." only, with at
//     least one letter or digit: no emoji, symbols, "<" ">" (Unity rich
//     text), control, invisible or combining characters
//   - letters from one alphabet (Latin, Cyrillic or Greek), so look-alikes
//     such as a Cyrillic "а" in "admin" can't pass for another name
export type NameCheck =
    | { ok: true; name: string }
    | { ok: false; reason: 'length' | 'chars' | 'mixed' | 'spacing' };

const MIN = 3;
const MAX = 20;
const ALLOWED = /^[\p{L}0-9 _.\-]+$/u;
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

export function normalizeName(name: string): string {
    return name.normalize('NFKC').trim();
}

export function checkName(raw: unknown): NameCheck {
    if (typeof raw !== 'string') return { ok: false, reason: 'length' };
    // A lone surrogate can't be folded or shown; refuse it outright.
    if (!raw.isWellFormed()) return { ok: false, reason: 'chars' };
    const name = normalizeName(raw);
    const length = [...name].length;
    if (length < MIN || length > MAX) return { ok: false, reason: 'length' };
    if (!ALLOWED.test(name) || !/[\p{L}0-9]/u.test(name)) return { ok: false, reason: 'chars' };
    const letters = [...name].filter((c) => /\p{L}/u.test(c));
    // Letters outside these three alphabets (e.g. the invisible Hangul filler) are refused.
    if (!letters.every((c) => SCRIPTS.some((s) => s.test(c)))) return { ok: false, reason: 'chars' };
    if (SCRIPTS.filter((s) => letters.some((c) => s.test(c))).length > 1) return { ok: false, reason: 'mixed' };
    if (name.includes('  ')) return { ok: false, reason: 'spacing' };
    return { ok: true, name };
}
