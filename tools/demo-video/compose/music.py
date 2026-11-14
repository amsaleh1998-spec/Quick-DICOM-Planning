"""The soundtrack: an original instrumental piece synthesised here (no samples, nothing licensed), cut to the video.

  python3 music.py <seconds> <out.wav> [drop_seconds]

Acoustic instruments, modelled: a finger-picked guitar (plucked-string model), piano, upright bass,
a soft string section, shaker and a hand drum. 32 bars over the length of the video, Am - F - C - G with a
chord every two bars: the guitar alone to open, bass and a piano melody as the work starts, percussion and
strings through the planning, strummed chords and the melody an octave up from `drop` (the 3D shot),
one last chord under the closing card.
"""
import sys
import wave

import numpy as np
from scipy.signal import butter, lfilter

SR = 48000
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 68.4
OUT = sys.argv[2] if len(sys.argv) > 2 else 'music.wav'
BARS = 32
BAR = DUR / BARS
BEAT = BAR / 4
N = int(DUR * SR)
TAIL = SR * 6
rng = np.random.default_rng(11)
L = np.zeros(N + TAIL)
R = np.zeros(N + TAIL)
WL = np.zeros(N + TAIL)  # what goes to the room
WR = np.zeros(N + TAIL)

note = lambda n: 440.0 * 2 ** ((n - 69) / 12)  # MIDI number -> Hz
# guitar voicings (low to high) and bass note: Am, F, C, G
CHORDS = [(45, [45, 52, 57, 60, 64]), (41, [41, 48, 53, 57, 60]), (48, [48, 52, 55, 60, 64]), (43, [43, 50, 55, 59, 62])]
chord = lambda bar: CHORDS[0 if bar >= BARS - 2 else (bar // 2) % 4]


def lp(x, hz, order=2):
    b, a = butter(order, min(0.45, hz / (SR / 2)), 'low')
    return lfilter(b, a, x)


def hp(x, hz, order=2):
    b, a = butter(order, hz / (SR / 2), 'high')
    return lfilter(b, a, x)


def put(sig, t, gain=1.0, pan=0.0, room=0.25):
    i = max(0, int(t * SR))
    n = min(len(sig), N + TAIL - i)
    l, r = sig[:n] * gain * np.sqrt(1 - pan), sig[:n] * gain * np.sqrt(1 + pan)
    L[i:i + n] += l
    R[i:i + n] += r
    WL[i:i + n] += l * room
    WR[i:i + n] += r * room


def string(f, dur, bright=0.5, damp=0.996, pick=0.2):
    """A plucked string (Karplus-Strong): a burst of noise going round a delay line that loses its highs.
    `bright`: how hard the pluck is; `pick`: where along the string (0..0.5)."""
    n = int(dur * SR)
    P = SR / f - 0.5  # the averaging in the loop is half a sample long
    D = int(P)
    fr = P - D
    burst = rng.uniform(-1, 1, D + 2)
    burst = lp(burst, 1200 + 9000 * bright, 1)
    k = max(1, int(pick * D))  # plucking at a point removes the harmonics with a node there
    burst[k:] -= burst[:-k]
    x = np.zeros(n)
    x[:len(burst)] = burst
    a = np.zeros(D + 3)
    a[0] = 1
    a[D], a[D + 1], a[D + 2] = -damp * 0.5 * (1 - fr), -damp * 0.5, -damp * 0.5 * fr
    y = lfilter([1], a, x)
    y *= np.minimum(1, np.maximum(0, (n - np.arange(n)) / (0.03 * SR)))
    return y / (np.abs(y).max() + 1e-9)


def body(x):
    """The guitar's box: two broad resonances."""
    out = x * 0.6
    for f0, q, g in ((110, 4, 0.5), (220, 5, 0.35)):
        b, a = butter(1, [f0 / q * (q - 0.5) / (SR / 2), f0 / q * (q + 0.5) / (SR / 2)], 'band')
        out = out + lfilter(b, a, x) * g
    return out


def guitar(n, dur=2.2, vel=1.0):
    f = note(n)
    return body(string(f, dur, 0.35 + 0.3 * vel, 0.9975 - 0.0008 * (n - 45) / 20, 0.18)) * vel


def upright(n, dur=1.4):
    return lp(string(note(n), dur, 0.15, 0.992, 0.3), 900)


def piano(n, dur=3.0, vel=1.0):
    f = note(n)
    t = np.arange(int(dur * SR)) / SR
    B = 0.0004  # stiff strings: partials a little sharp
    x = np.zeros(len(t))
    for k in range(1, 9):
        fk = f * k * np.sqrt(1 + B * k * k)
        if fk > 9000:
            break
        amp = (1.0 / k ** 1.3) * (0.55 + 0.45 * vel) ** (k - 1)
        two = 0.7 * np.exp(-t * (1.6 + 0.9 * k)) + 0.3 * np.exp(-t * (0.5 + 0.12 * k))  # fast, then slow decay
        x += amp * (np.sin(2 * np.pi * fk * t) + 0.5 * np.sin(2 * np.pi * fk * 1.0009 * t + 1.0)) * two
    hammer = lp(rng.standard_normal(len(t)), 3000) * np.exp(-t * 220) * 0.08
    e = np.minimum(1, t / 0.003) * np.minimum(1, np.maximum(0, (dur - t) / 0.08))
    return (x * 0.5 + hammer) * e * vel


def strings(notes, dur, cut=1500):
    """A soft string section behind everything."""
    n = int((dur + 1.4) * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for m in notes:
        for det in (-0.006, -0.002, 0.003, 0.007):
            vib = 1 + 0.003 * np.sin(2 * np.pi * (4.8 + rng.random()) * t + rng.random() * 6)
            x += 2 * ((np.cumsum(note(m) * (1 + det) * vib) / SR + rng.random()) % 1) - 1
    x = lp(x, cut, 2) / (len(notes) * 4)
    return x * np.minimum(1, t / 1.0) ** 1.5 * np.minimum(1, np.maximum(0, (dur + 1.4 - t) / 1.4))


def shaker(vel=1.0):
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    return hp(lp(rng.standard_normal(n), 9000), 4500) * np.minimum(1, t / 0.012) * np.exp(-t * 55) * vel


def hand_drum(low=True):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    if low:  # palm in the middle of the head
        f = 62 + 40 * np.exp(-t * 40)
        return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 13) + 0.2 * lp(rng.standard_normal(n), 800) * np.exp(-t * 70)
    f = 190 + 60 * np.exp(-t * 60)  # fingers at the edge
    return 0.5 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 30) + 0.6 * hp(lp(rng.standard_normal(n), 5000), 700) * np.exp(-t * 55)


def bell(n, dur=2.0):
    """Glockenspiel: a few inharmonic partials."""
    f = note(n)
    t = np.arange(int(dur * SR)) / SR
    return sum(a * np.sin(2 * np.pi * f * r * t) * np.exp(-t * d) for r, a, d in ((1, 1, 3.0), (2.76, 0.35, 6), (5.4, 0.15, 10))) * np.minimum(1, t / 0.002)


drop_bar = int(round((float(sys.argv[3]) if len(sys.argv) > 3 else 51.3) / BAR / 2)) * 2
END = BARS - 2  # the last two bars: the closing card
# the melody, two bars a phrase (beat, beats long, note); it follows the chords
MELODY = {0: [(0, 3, 76), (3, 1, 74), (4, 4, 72)], 1: [(0, 3, 72), (3, 1, 74), (4, 4, 77)],
          2: [(0, 3, 79), (3, 1, 76), (4, 4, 72)], 3: [(0, 2, 74), (2, 2, 79), (4, 4, 74)]}

for bar in range(0, BARS, 2):  # two bars per chord
    t0 = bar * BAR
    root, v = chord(bar)
    full = drop_bar <= bar < END
    last = bar >= END
    if last:  # one slow strum and a piano chord, left to ring
        for k, m in enumerate(v + [v[2] + 12]):
            put(guitar(m, 6.0, 0.9), t0 + k * 0.045, 0.3, -0.25 + 0.1 * k, 0.4)
        for m in (root - 12, v[2], v[4]):
            put(piano(m, 6.0, 0.7), t0, 0.22, 0.15, 0.5)
        put(strings([root, v[2], v[3] + 12], 2 * BAR, 1400), t0, 0.28, 0, 0.5)
        break
    # guitar: finger-picked eighths (thumb on the low strings, fingers on top), from the first bar
    pattern = [0, 2, 3, 2, 4, 2, 3, 2] if bar % 4 == 0 else [0, 2, 4, 3, 1, 3, 4, 2]
    for rep in range(2):
        for k, sidx in enumerate(pattern):
            h = (rng.random() - 0.5) * 0.012  # a hand is never quite on the grid
            vel = (0.95 if k in (0, 4) else 0.7) * (0.85 + 0.15 * rng.random()) * (0.8 + 0.2 * min(1, bar / 6))
            put(guitar(v[sidx], 2.4, vel), t0 + rep * BAR + k * BEAT / 2 + h, 0.75 if bar < 8 else 0.5 if not full else 0.36, -0.3, 0.3)
    # from the drop: a second guitar strums the chord on the beats
    if full:
        for b in (0, 1.5, 2.5, 4, 5.5, 6.5, 7):
            down = b in (0, 2.5, 4, 6.5)
            order = v if down else v[::-1]
            for k, m in enumerate(order):
                put(guitar(m + 12 if k > 2 and down else m, 1.6, 0.7 if down else 0.5), t0 + b * BEAT + k * 0.014, 0.13, 0.35, 0.3)
    # upright bass
    if bar >= 8:
        for b, m, d in ((0, root - 12, 1.6), (3, root - 5, 0.7), (4, root - 12, 1.6), (6.5, root - 12, 0.5), (7, root - 5 if bar % 4 else root - 10, 0.8)):
            if bar < 12 and b not in (0, 4):
                continue
            put(upright(m, d), t0 + b * BEAT, 0.42, 0.0, 0.12)
    # piano: the melody (an octave up, with bells, over the 3D shot); a low chord under it
    if bar >= 8:
        for b, d, m in MELODY[(bar // 2) % 4]:
            hgt = 12 if full else 0
            put(piano(m - 12 + hgt, d * BEAT + 1.5, 0.75), t0 + b * BEAT, 0.19, 0.2, 0.45)
            if full:
                put(bell(m + 12), t0 + b * BEAT, 0.05, 0.4, 0.6)
        if bar >= 16:
            for m in (v[1], v[3]):
                put(piano(m, 3.0, 0.5), t0, 0.12, 0.1, 0.4)
                put(piano(m, 3.0, 0.5), t0 + 4 * BEAT, 0.1, 0.1, 0.4)
    # strings: far back from bar 12, closer from the drop
    if bar >= 12:
        put(strings([root, v[2], v[3]], 2 * BAR, 1200 + (900 if full else 0)), t0, 0.2 + (0.12 if full else 0), -0.1, 0.5)
        if bar >= 20:
            put(strings([v[4] + 12], 2 * BAR, 2200), t0, 0.1 + (0.08 if full else 0), 0.3, 0.5)
    # percussion: shaker from bar 12, the hand drum from bar 16
    if bar >= 12:
        for k in range(16):
            put(shaker(1.0 if k % 2 == 0 else 0.55), t0 + k * BEAT / 2 + (0.006 if k % 2 else 0), 0.07 if not full else 0.09, 0.45, 0.2)
    if bar >= 16:
        for b, low, g in ((0, True, 1.0), (1, False, 0.5), (2.5, True, 0.7), (3, False, 0.6), (4, True, 1.0), (5, False, 0.5), (6.5, True, 0.7), (7, False, 0.6), (7.5, False, 0.4)):
            put(hand_drum(low), t0 + b * BEAT, (0.3 if low else 0.16) * g * (1.15 if full else 1.0), -0.1 if low else 0.25, 0.25)

# a soft cymbal swell into the drop
n = int(2 * BAR * SR)
put(hp(rng.standard_normal(n), 5000) * (np.arange(n) / n) ** 3, drop_bar * BAR - 2 * BAR, 0.05, 0, 0.5)


def room(x, seed):
    """A warm room: feedback combs, then two all-passes."""
    r = np.random.default_rng(seed)
    y = np.zeros_like(x)
    for d in (0.0297, 0.0371, 0.0411, 0.0437, 0.0533, 0.0617):
        k = int(d * (1 + 0.03 * r.random()) * SR)
        a = np.zeros(k + 1)
        a[0], a[k] = 1, -0.78
        y += lfilter([1], a, x)
    y = lp(y, 6000) / 6
    for d, g in ((0.0087, 0.6), (0.0031, 0.6)):
        k = int(d * SR)
        b = np.zeros(k + 1)
        a = np.zeros(k + 1)
        b[0], b[k] = -g, 1
        a[0], a[k] = 1, -g
        y = lfilter(b, a, y)
    return y


L = (L + room(WL, 1))[:N]
R = (R + room(WR, 2))[:N]
fade = np.ones(N)
fo = int(2.6 * SR)
fade[N - fo:] = np.cos(np.linspace(0, np.pi / 2, fo)) ** 2
fade[:int(0.01 * SR)] = np.linspace(0, 1, int(0.01 * SR))
L, R = hp(L, 30) * fade, hp(R, 30) * fade
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = np.tanh(L / peak * 1.2) / np.tanh(1.2), np.tanh(R / peak * 1.2) / np.tanh(1.2)
pcm = (np.stack([L, R], 1) * 0.89 * 32767).astype('<i2')
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', OUT, f'{DUR:.1f} s, bar {BAR:.3f} s, drop at bar {drop_bar} = {drop_bar * BAR:.1f} s')
