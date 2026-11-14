"""The soundtrack: an original cinematic piece synthesised here (no samples, nothing licensed), cut to the video.

  python3 music.py <seconds> <out.wav> [drop_seconds]

32 bars over the length of the video, Am - F - C - G with a chord every two bars: a piano figure over low
strings to open, a string ostinato and deep hits as the work starts, drums and high strings through the
planning, the full orchestra with a horn line from `drop` (the 3D shot), one last chord under the closing card.
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
rng = np.random.default_rng(5)
# two busses: `dry` instruments get a little hall, `wet` ones (piano, drums, horns) a lot
bus = {k: [np.zeros(N + TAIL), np.zeros(N + TAIL)] for k in ('dry', 'wet', 'low')}

note = lambda n: 440.0 * 2 ** ((n - 69) / 12)  # MIDI number -> Hz
# (bass, chord tones): Am, F, C, G
CHORDS = [(33, [57, 60, 64]), (29, [53, 57, 60]), (36, [55, 60, 64]), (31, [55, 59, 62])]
chord = lambda bar: CHORDS[0 if bar >= BARS - 2 else (bar // 2) % 4]


def lp(x, hz, order=2):
    b, a = butter(order, min(0.45, hz / (SR / 2)), 'low')
    return lfilter(b, a, x)


def hp(x, hz, order=2):
    b, a = butter(order, hz / (SR / 2), 'high')
    return lfilter(b, a, x)


def saw(f, n, ph=0.0):
    return 2 * ((f * np.arange(n) / SR + ph) % 1.0) - 1


def put(sig, t, gain=1.0, pan=0.0, to='dry'):
    i = int(t * SR)
    n = min(len(sig), N + TAIL - i)
    bus[to][0][i:i + n] += sig[:n] * gain * np.sqrt(1 - pan)
    bus[to][1][i:i + n] += sig[:n] * gain * np.sqrt(1 + pan)


def strings(freqs, dur, cut, attack=0.9, release=1.2):
    """A string section: detuned saws per note, slow bow, a slow shimmer."""
    n = int((dur + release) * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for f in freqs:
        for det in (-0.007, -0.002, 0.003, 0.008):
            vib = 1 + 0.0025 * np.sin(2 * np.pi * (4.6 + rng.random()) * t + rng.random() * 6)
            x += 2 * ((np.cumsum(f * (1 + det) * vib) / SR + rng.random()) % 1) - 1
    x = lp(x, cut, 2) / (len(freqs) * 4)
    e = np.minimum(1, t / attack) ** 1.5 * np.minimum(1, np.maximum(0, (dur + release - t) / release))
    return x * e


def spicc(f, dur=0.16, cut=2600):
    """A short bow stroke (the ostinato)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = sum(saw(f * (1 + d), n, rng.random()) for d in (-0.005, 0.0, 0.006))
    return lp(x, cut) * np.minimum(1, t / 0.008) * np.exp(-t * 16) / 3


def piano(f, dur=2.4, vel=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = sum(a * np.sin(2 * np.pi * f * k * (1 + 0.0004 * k * k) * t) * np.exp(-t * (1.1 + 0.55 * k)) for k, a in ((1, 1.0), (2, 0.5), (3, 0.28), (4, 0.14), (5, 0.08), (6, 0.04)))
    hammer = lp(rng.standard_normal(n), 2500) * np.exp(-t * 180) * 0.15
    return (x + hammer) * np.minimum(1, t / 0.004) * vel


def horn(f, dur):
    """French-horn-like: a filtered saw that opens as it swells."""
    n = int((dur + 0.5) * SR)
    t = np.arange(n) / SR
    vib = 1 + 0.003 * np.sin(2 * np.pi * 5 * t) * np.minimum(1, t / 0.4)
    ph = np.cumsum(f * vib) / SR
    x = (2 * (ph % 1) - 1) + 0.5 * (2 * ((ph * 1.003) % 1) - 1)
    e = np.minimum(1, t / 0.35) ** 1.5 * np.minimum(1, np.maximum(0, (dur + 0.5 - t) / 0.5))
    return (0.75 * lp(x, 450) + 0.25 * lp(x, 900) * e) * e * 0.6


def boom(low=38, length=3.2):
    """A deep hit: a falling sub and a dull thud."""
    n = int(length * SR)
    t = np.arange(n) / SR
    f = low + 50 * np.exp(-t * 14)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.9) + 0.5 * lp(rng.standard_normal(n), 220) * np.exp(-t * 7)


def drum(f0=74, length=0.9, snap=0.25):
    """A big low drum (taiko-like)."""
    n = int(length * SR)
    t = np.arange(n) / SR
    f = f0 + 70 * np.exp(-t * 30)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5)
    skin = lp(hp(rng.standard_normal(n), 300), 3000) * np.exp(-t * 45) * snap
    return body + skin


def swell(dur, bright=False):
    """Air rising into a downbeat."""
    n = int(dur * SR)
    t = np.arange(n) / n
    x = hp(lp(rng.standard_normal(n), 6000 if bright else 2500), 300)
    return x * t ** 3


drop_bar = int(round((float(sys.argv[3]) if len(sys.argv) > 3 else 51.3) / BAR / 2)) * 2
END = BARS - 2  # the last two bars: the closing card

for bar in range(0, BARS, 2):  # two bars per chord
    t0 = bar * BAR
    root, tones = chord(bar)
    full = drop_bar <= bar < END
    last = bar >= END
    grow = min(1.0, bar / 20)
    # low strings from the start; they open up as the piece grows
    cut = 700 + 2400 * grow + (2200 if full else 0)
    put(strings([note(root + 12), note(root + 19), note(tones[1] - 12)], 2 * BAR, cut), t0, 0.5 + 0.25 * grow, -0.2)
    put(strings([note(root)], 2 * BAR, 300 + 400 * grow, attack=0.5), t0, 0.5, 0.0, 'low')
    if bar >= 8:  # mid strings
        put(strings([note(n) for n in tones], 2 * BAR, cut * 1.3), t0, 0.32 + 0.2 * grow, 0.25)
    if bar >= 16 or last:  # high strings
        put(strings([note(tones[0] + 12), note(tones[2] + 12)], 2 * BAR, cut * 2.2, attack=1.2), t0, 0.22 + (0.2 if full or last else 0), 0.4)
    if last:
        put(piano(note(root + 24), 5, 0.9), t0, 0.28, 0, 'wet')
        put(piano(note(tones[2]), 5, 0.7), t0 + 0.02, 0.2, 0.2, 'wet')
        break
    # piano figure: sparse at first, every bar later (left out under the horns)
    fig = [(0, tones[0] + 12), (1.5, tones[2] + 12), (2, tones[1] + 12), (3.5, tones[2]), (4, tones[0] + 12), (5.5, tones[1] + 12), (6, tones[2] + 12), (7, tones[1] + 12)]
    if bar < 4:
        fig = fig[:3] + fig[6:7]
    if not full:
        for b, n in fig:
            put(piano(note(n), 2.6, 0.75 + 0.25 * rng.random()), t0 + b * BEAT, 0.2 if bar < 8 else 0.15, 0.25 * np.sin(b), 'wet')
    # ostinato: eighths from bar 8, sixteenth pick-ups from bar 16
    if bar >= 8:
        for k in range(16):
            f = note(tones[(0, 2, 1, 2)[k % 4]] + (12 if bar >= 16 and k % 8 >= 4 else 0))
            acc = 1.0 if k % 4 == 0 else 0.62
            put(spicc(f, cut=2600 + 3400 * grow), t0 + k * BEAT / 2, (0.26 + 0.2 * grow) * acc, -0.35)
            if bar >= 16 and k % 4 == 3:
                put(spicc(f * 2, 0.1, 3000), t0 + k * BEAT / 2 + BEAT / 4, 0.16, 0.35)
    # drums: a slow pulse from bar 12, the full pattern with fills from the drop
    if bar >= 12:
        pat = [(0, 1.0, 62), (3, 0.6, 74), (4, 0.9, 62), (6.5, 0.55, 82), (7, 0.7, 74)]
        if bar >= 20:
            pat += [(1.5, 0.45, 82), (2.5, 0.5, 74), (5.5, 0.45, 82)]
        if full:
            pat += [(7.5, 0.7, 82), (7.75, 0.8, 74), (2, 0.6, 62), (6, 0.7, 62)]
        for b, g, f0 in pat:
            put(drum(f0), t0 + b * BEAT, 0.5 * g * (1.2 if full else 0.85), 0.3 * (f0 - 70) / 12, 'wet')
    # horns over the 3D shot: one long line, doubled an octave up
    if full:
        mel = {0: [(0, 3, 64), (3, 1, 62), (4, 4, 60)], 1: [(0, 3, 60), (3, 1, 62), (4, 4, 65)],
               2: [(0, 3, 67), (3, 1, 64), (4, 4, 72)], 3: [(0, 2, 71), (2, 2, 67), (4, 4, 74)]}[(bar // 2) % 4]
        for b, d, n in mel:
            put(horn(note(n), d * BEAT), t0 + b * BEAT, 0.26, -0.1)
            put(horn(note(n - 12), d * BEAT), t0 + b * BEAT, 0.16, 0.15)

# deep hits where the picture turns; air rising into the big ones
for b, g in ((0, 0.5), (8, 0.55), (16, 0.6), (drop_bar, 0.7), (END, 0.7)):
    put(boom(), b * BAR, g, 0, 'low')
for b, g, bright in ((8, 0.06, False), (16, 0.09, False), (drop_bar, 0.22, True), (END, 0.12, True)):
    put(swell(2 * BAR, bright), b * BAR - 2 * BAR, g, 0, 'wet')
# a roll into the drop
for k in range(12):
    put(drum(74, 0.5), drop_bar * BAR - (12 - k) * BEAT / 4, 0.12 + 0.035 * k, 0.2, 'wet')


def hall(x, seed):
    """A large hall: parallel feedback combs, then two all-passes."""
    r = np.random.default_rng(seed)
    y = np.zeros_like(x)
    for d in (0.0437, 0.0571, 0.0683, 0.0797, 0.0911, 0.1039):
        k = int(d * (1 + 0.03 * r.random()) * SR)
        a = np.zeros(k + 1)
        a[0], a[k] = 1, -0.8
        y += lfilter([1], a, x)
    y = lp(y, 8000) / 6
    for d, g in ((0.0127, 0.6), (0.0041, 0.6)):
        k = int(d * SR)
        b = np.zeros(k + 1)
        a = np.zeros(k + 1)
        b[0], b[k] = -g, 1
        a[0], a[k] = 1, -g
        y = lfilter(b, a, y)
    return y


L = bus['dry'][0] + bus['wet'][0] + bus['low'][0]
R = bus['dry'][1] + bus['wet'][1] + bus['low'][1]
L += 0.22 * hall(bus['dry'][0], 1) + 0.35 * hall(bus['wet'][0], 2)
R += 0.22 * hall(bus['dry'][1], 3) + 0.35 * hall(bus['wet'][1], 4)
L, R = L[:N], R[:N]
fade = np.ones(N)
fo = int(2.4 * SR)
fade[N - fo:] = np.cos(np.linspace(0, np.pi / 2, fo)) ** 2
fade[:int(0.02 * SR)] = np.linspace(0, 1, int(0.02 * SR))
# a little air on top
L, R = (hp(L, 26) + 0.9 * hp(L, 3500, 1)) * fade, (hp(R, 26) + 0.9 * hp(R, 3500, 1)) * fade
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = np.tanh(L / peak * 1.5) / np.tanh(1.5), np.tanh(R / peak * 1.5) / np.tanh(1.5)
pcm = (np.stack([L, R], 1) * 0.89 * 32767).astype('<i2')
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', OUT, f'{DUR:.1f} s, bar {BAR:.3f} s, drop at bar {drop_bar} = {drop_bar * BAR:.1f} s')
