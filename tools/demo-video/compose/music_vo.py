"""Music for the voiceover cut: an original bed synthesised here (no samples, nothing licensed).

  python3 music_vo.py <video.vo.json> <out.wav>

About 123 beats a minute in A minor, warm and led by the bass, at an even level so that a voice sits
on it: a plucked bass figure, a soft kick, rim and shaker, electric-piano chords off the beat. Parts
come in where the video's scenes start (from the .vo.json the editor writes): keys alone for the
opening, the bass when the scan is dropped in, the groove for the alignment and the planning, a
higher line over the 3D shot, one chord left ringing under the closing card.
"""
import json, sys, wave
import numpy as np
from scipy.signal import butter, lfilter

SR = 48000
info = json.load(open(sys.argv[1]))
DUR = info['seconds']
T = info['starts']
BARS = int(round(DUR / (240 / 123)))
BAR = DUR / BARS
BEAT = BAR / 4
S16 = BEAT / 4
N = int(DUR * SR)
rng = np.random.default_rng(21)
L = np.zeros(N + SR * 4); R = np.zeros(N + SR * 4)
bar_of = lambda t: int(round(t / BAR))
note = lambda n: 440.0 * 2 ** ((n - 69) / 12)
CH = [(45, [57, 60, 64, 67]), (41, [57, 60, 65, 69]), (48, [55, 60, 64, 67]), (43, [55, 59, 62, 67])]  # Am7 F C G


def lp(x, hz, o=2):
    b, a = butter(o, min(0.45, hz / (SR / 2)), 'low'); return lfilter(b, a, x)


def hp(x, hz, o=2):
    b, a = butter(o, hz / (SR / 2), 'high'); return lfilter(b, a, x)


def put(x, t, g=1.0, pan=0.0):
    i = int(t * SR); n = min(len(x), len(L) - i)
    if n <= 0 or i < 0: return
    L[i:i + n] += x[:n] * g * np.sqrt(1 - pan); R[i:i + n] += x[:n] * g * np.sqrt(1 + pan)


def bass(f, dur):
    """A plucked, slightly driven bass: round, with a short bite."""
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t + 1.6 * np.exp(-t * 18) * np.sin(2 * np.pi * 2 * f * t))
    x = np.tanh(1.6 * x) * (0.25 + 0.75 * np.exp(-t * 7)) * np.minimum(1, t / 0.004) * np.minimum(1, (dur - t) / 0.02)
    return hp(lp(x, 1100), 45)


def keys(f, dur, vel=1.0):
    """Electric piano: a sine with a bell that dies quickly (two-operator FM)."""
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t + (1.4 * vel) * np.exp(-t * 9) * np.sin(2 * np.pi * f * 14 * t) * 0.12 + 0.9 * vel * np.exp(-t * 5) * np.sin(2 * np.pi * f * t))
    trem = 1 + 0.06 * np.sin(2 * np.pi * 4.6 * t)
    return x * trem * np.exp(-t * 2.4) * np.minimum(1, t / 0.006) * np.minimum(1, (dur - t) / 0.03) * vel


def pluck(f, dur=0.5):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 14) + 0.2 * np.sin(2 * np.pi * 3.01 * f * t) * np.exp(-t * 22)
    return x * np.exp(-t * 9) * np.minimum(1, t / 0.003)


def kick():
    n = int(0.3 * SR); t = np.arange(n) / SR
    return np.sin(2 * np.pi * np.cumsum(48 + 70 * np.exp(-t * 30)) / SR) * np.exp(-t * 11)


def rim():
    n = int(0.09 * SR); t = np.arange(n) / SR
    return (0.6 * np.sin(2 * np.pi * 1750 * t) + 0.5 * np.sin(2 * np.pi * 820 * t) + 0.4 * hp(rng.standard_normal(n), 2500)) * np.exp(-t * 75)


def shaker(v):
    n = int(0.07 * SR); t = np.arange(n) / SR
    return hp(lp(rng.standard_normal(n), 8500), 4200) * np.minimum(1, t / 0.01) * np.exp(-t * 60) * v


def pad(freqs, dur):
    n = int((dur + 1.0) * SR); t = np.arange(n) / SR; x = np.zeros(n)
    for f in freqs:
        for d in (-0.004, 0.004):
            x += np.sin(2 * np.pi * f * (1 + d) * t + rng.random() * 6) + 0.3 * np.sin(2 * np.pi * 2 * f * (1 + d) * t)
    return lp(x, 2600) / (2.6 * len(freqs)) * np.minimum(1, t / 0.8) * np.minimum(1, np.maximum(0, (dur + 1.0 - t) / 1.0))


b_bass = bar_of(T.get('open', 4) + 6)      # the scan is dropped in
b_drums = bar_of(T.get('ai', 16))          # the kick
b_groove = bar_of(T.get('scans', 24))      # rim and shaker
b_full = bar_of(T.get('curve', 44))        # chords every bar, the pluck line
b_hero = bar_of(T.get('hero', 78))
b_out = bar_of(T.get('report', 88))
END = bar_of(T.get('outro', DUR - 4))
# the bass figure in sixteenths: (step, length in steps, semitones above the root)
FIG = [(0, 2, 0), (3, 1, 0), (6, 2, 12), (8, 2, 0), (11, 1, 7), (14, 2, 10)]
FIG2 = [(0, 2, 0), (3, 1, 0), (6, 1, 12), (7, 1, 10), (8, 2, 7), (11, 1, 0), (13, 1, 3), (14, 2, 5)]

for bar in range(BARS):
    t0 = bar * BAR
    root, tones = CH[bar % 4]
    if bar >= END:
        if bar == END:
            for k, m in enumerate(tones):
                put(keys(note(m), 5.0, 0.8), t0 + 0.012 * k, 0.16, -0.3 + 0.2 * k)
            put(bass(note(33), 3.0), t0, 0.3)
            put(pad([note(m) for m in CH[0][1]], 3.5), t0, 0.5)
        continue
    hero = b_hero <= bar < b_out
    # a soft pad throughout: the floor everything stands on
    put(pad([note(m) for m in tones[:3]], BAR), t0, 0.3 if bar < b_bass else 0.16, 0.0)
    # keys: a chord off the beat (2-and, 4-and); in the opening one soft chord a bar
    hits = [1.5, 3.5] if bar >= b_bass else [0]
    if bar >= b_full: hits = [0.75, 1.5, 3.5] if bar % 2 else [1.5, 2.75, 3.5]
    for h in hits:
        for k, m in enumerate(tones):
            put(keys(note(m), 0.9 if bar >= b_bass else 2.4, 0.7 + 0.15 * rng.random()), t0 + h * BEAT + 0.006 * k, 0.2 if bar >= b_bass else 0.2, -0.35 + 0.23 * k)
    if bar >= b_bass:
        for st, ln, semi in (FIG2 if bar % 4 == 3 else FIG):
            put(bass(note(root - 12 + semi if root > 44 else root + semi), ln * S16 * 0.92), t0 + st * S16, 0.24)
    if bar >= b_drums and bar < b_out + 2:
        for b in range(4):
            put(kick(), t0 + b * BEAT, 0.26)
    if bar >= b_groove and bar < b_out + 2:
        for b in (1, 3):
            put(rim(), t0 + b * BEAT, 0.3, 0.15)
        if bar % 4 == 3:
            put(rim(), t0 + 3.75 * BEAT, 0.12, -0.2)
        for k in range(16):
            sw = S16 * 0.12 if k % 2 else 0  # a little swing
            put(shaker((1.0, 0.45, 0.7, 0.45)[k % 4]), t0 + k * S16 + sw, 0.2, 0.4)
    # the pluck line: sparse through the planning, an octave up and busier over the 3D shot
    if bar >= b_full and bar < b_out:
        line = [(0, tones[2]), (1.5, tones[3]), (2.5, tones[1]), (3.5, tones[2])] if not hero else [(0, tones[3] + 12), (0.75, tones[2] + 12), (1.5, tones[1] + 12), (2.5, tones[3] + 12), (3, tones[2] + 12), (3.5, tones[0] + 12)]
        for b, m in line:
            x = pluck(note(m + 12))
            put(x, t0 + b * BEAT, 0.17 if not hero else 0.19, 0.3)
            put(x, t0 + b * BEAT + 0.75 * BEAT, 0.06, -0.4)

# lift into the 3D shot: air rising over two bars
n = int(2 * BAR * SR)
put(hp(lp(rng.standard_normal(n), 6000), 500) * (np.arange(n) / n) ** 3, (b_hero - 2) * BAR, 0.07)

# a small room, a gentle top roll-off, and out
def room(x):
    y = np.zeros_like(x)
    for d, g in ((0.023, 0.35), (0.037, 0.28), (0.053, 0.2), (0.079, 0.14)):
        k = int(d * SR); y[k:] += lp(x, 3500)[:-k] * g
    return y
wl, wr = room(R), room(L)
L += 0.2 * wl; R += 0.2 * wr
# (the parts are dark on their own: lift what is above the bass)
tilt = lambda x: x + 1.6 * hp(x, 700, 1) + 1.2 * hp(x, 2500, 1)
L, R = lp(tilt(hp(L[:N], 32)), 12000, 1), lp(tilt(hp(R[:N], 32)), 12000, 1)
fade = np.ones(N); fo = int(2.2 * SR); fade[-fo:] = np.cos(np.linspace(0, np.pi / 2, fo)) ** 2; fade[:480] = np.linspace(0, 1, 480)
L *= fade; R *= fade
pk = max(abs(L).max(), abs(R).max()); L, R = np.tanh(L / pk * 1.3) / np.tanh(1.3), np.tanh(R / pk * 1.3) / np.tanh(1.3)
with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.stack([L, R], 1) * 0.85 * 32767).astype('<i2').tobytes())
print(f'wrote {sys.argv[2]}: {DUR:.1f} s, {BARS} bars, {240 / BAR:.1f} BPM; bass from bar {b_bass}, kick {b_drums}, groove {b_groove}, full {b_full}, 3D {b_hero}, out {b_out}, end {END}')
