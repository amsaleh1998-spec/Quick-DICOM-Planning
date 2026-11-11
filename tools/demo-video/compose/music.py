"""The soundtrack: an original piece synthesised here (no samples, nothing licensed), cut to the video.

  python3 music.py <seconds> <out.wav> [drop_seconds]

32 bars over the length of the video, Am - F - C - G: a pad and a pluck to open, kick and bass under the
first steps, hats and an arpeggio through the planning, everything with a lead from `drop` (the 3D shot),
a last chord under the closing card.
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
rng = np.random.default_rng(3)
L = np.zeros(N + SR * 3)
R = np.zeros(N + SR * 3)

A4 = 440.0
note = lambda n: A4 * 2 ** ((n - 69) / 12)  # MIDI number -> Hz
CHORDS = [(45, [57, 60, 64, 67]), (41, [57, 60, 65, 69]), (48, [55, 60, 64, 67]), (43, [55, 59, 62, 67])]  # Am7, F, C, G


def lp(x, hz, order=2):
    b, a = butter(order, min(0.45, hz / (SR / 2)), 'low')
    return lfilter(b, a, x)


def hp(x, hz, order=2):
    b, a = butter(order, hz / (SR / 2), 'high')
    return lfilter(b, a, x)


def saw(f, n, det=0.0, ph=0.0):
    t = np.arange(n) / SR
    return 2 * ((f * (1 + det) * t + ph) % 1.0) - 1


def env(n, a, d, s=0.0, r=0.0):
    """Attack / decay to `s` / release, in seconds, over n samples."""
    e = np.full(n, s)
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    e[:min(na, n)] = np.linspace(0, 1, na)[:n]
    k = np.arange(max(0, min(nd, n - na)))
    e[na:na + len(k)] = s + (1 - s) * np.exp(-5 * k / max(1, nd))
    if nr:
        e[-min(nr, n):] *= np.linspace(1, 0, min(nr, n))
    return e


def put(sig, t, gain=1.0, pan=0.0):
    i = int(t * SR)
    n = len(sig)
    L[i:i + n] += sig * gain * np.sqrt((1 - pan) / 2) * 1.414
    R[i:i + n] += sig * gain * np.sqrt((1 + pan) / 2) * 1.414


def kick():
    n = int(0.32 * SR)
    t = np.arange(n) / SR
    f = 46 + 110 * np.exp(-t * 38)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9) + 0.25 * hp(rng.standard_normal(n), 3000) * np.exp(-t * 300)


def clap():
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    x = hp(lp(rng.standard_normal(n), 5500), 900)
    e = sum(np.exp(-np.maximum(t - d, 0) * 55) * (t >= d) for d in (0, 0.011, 0.023)) / 3
    return x * e


def hat(open_=False):
    n = int((0.16 if open_ else 0.05) * SR)
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7500) * np.exp(-t * (22 if open_ else 90))


def pluck(f, dur, bright=3200):
    n = int(dur * SR)
    x = saw(f, n, 0.003, rng.random()) + saw(f, n, -0.003, rng.random()) + 0.5 * saw(f * 2, n, 0.001, rng.random())
    e = env(n, 0.003, dur * 0.8, 0.0, 0.01)
    return lp(x, bright) * e * 0.33


def pad(freqs, dur, cut):
    n = int(dur * SR)
    x = np.zeros(n)
    for f in freqs:
        for det in (-0.006, 0.0, 0.007):
            x += saw(f, n, det, rng.random())
    x = lp(x, cut, 2)
    return x * env(n, 0.35, 0.1, 1.0, 0.5) / (len(freqs) * 3)


def bass(f, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t) + 0.35 * lp(saw(f, n), 500)
    return x * env(n, 0.005, dur, 0.55, 0.02)


def lead(f, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.minimum(1, t / 0.25)
    ph = np.cumsum(f * vib) / SR
    x = (2 * (ph % 1) - 1) + 0.6 * np.sign(np.sin(2 * np.pi * ph * 0.5 + 0.3))
    return lp(x, 2600) * env(n, 0.02, dur, 0.6, 0.06) * 0.3


drop_bar = int(round((float(sys.argv[3]) if len(sys.argv) > 3 else 51.3) / BAR))
END = BARS - 2  # the last two bars: the closing card

duck = np.ones(len(L))  # the kick pushes pad and bass down a little ("sidechain")
for bar in range(BARS):
    t0 = bar * BAR
    root, tones = CHORDS[bar % 4]
    full = drop_bar <= bar < END
    drums = 4 <= bar < END
    busy = 12 <= bar < END
    # pad: opens up over the piece
    cut = 500 + 2600 * min(1, bar / 14) + (1500 if full else 0)
    put(pad([note(n) for n in tones], BAR + 0.5, cut), t0, 0.75 if bar < END else 0.85, -0.15)
    put(pad([note(n + 12) for n in tones[1:]], BAR + 0.5, cut * 0.8), t0, 0.36, 0.25)
    # pluck motif: from the start; an octave up and in 16ths once it gets busy
    seq = [0, 2, 1, 3, 2, 1, 3, 2] if not busy else [0, 1, 2, 3, 2, 1, 2, 3, 0, 2, 1, 3, 2, 3, 1, 2]
    step = BAR / len(seq)
    for k, s in enumerate(seq):
        if bar >= END and k > 0:
            break
        f = note(tones[s] + (12 if busy else 0))
        g = (0.6 if not busy else 0.46) * (1.0 if k % 2 == 0 else 0.75) * (0.55 + 0.45 * min(1, (bar + 1) / 3))
        p = pluck(f, step * 1.9, 1800 + 300 * bar if not full else 5200)
        put(p, t0 + k * step, g, 0.45 * (-1) ** k)
        put(p, t0 + k * step + BEAT * 0.75, g * 0.3, -0.6 * (-1) ** k)  # echo
    # bass
    if 4 <= bar < END:
        pat = [(0, 1.5), (1.5, 0.5), (2, 1.0), (3, 0.5), (3.5, 0.5)] if busy else [(0, 2), (2, 1.5), (3.5, 0.5)]
        for b, d in pat:
            put(bass(note(root - 12 if root > 44 else root), d * BEAT * 0.95), t0 + b * BEAT, 0.24)
    elif bar >= END and bar == END:
        put(bass(note(33), BAR * 1.8) * np.linspace(1, 0, int(BAR * 1.8 * SR)), t0, 0.5)
    # drums
    if drums:
        beats = [0, 1, 2, 3] if bar >= 8 else [0, 2]
        for b in beats:
            put(kick(), t0 + b * BEAT, 0.5)
            i = int((t0 + b * BEAT) * SR)
            n = int(0.24 * SR)
            duck[i:i + n] = np.minimum(duck[i:i + n], 0.45 + 0.55 * np.linspace(0, 1, n) ** 1.5)
        if bar >= 8:
            for b in (1, 3):
                put(clap(), t0 + b * BEAT, 0.5, 0.05)
        if busy:
            for k in range(8):
                put(hat(k == 7 and bar % 2 == 1), t0 + k * BEAT / 2 + BEAT / 4, 0.3 if k % 2 else 0.2, 0.3)
        elif bar >= 8:
            for b in range(4):
                put(hat(), t0 + b * BEAT + BEAT / 2, 0.24, 0.3)
    # lead: a simple line over the 3D shot
    if full:
        mel = {0: [(0, 1.5, 76), (1.5, 0.5, 74), (2, 2, 72)], 1: [(0, 1.5, 72), (1.5, 0.5, 74), (2, 2, 77)],
               2: [(0, 1.5, 79), (1.5, 0.5, 76), (2, 2, 72)], 3: [(0, 1, 74), (1, 1, 79), (2, 2, 83)]}[bar % 4]
        for b, d, n in mel:
            x = lead(note(n), d * BEAT)
            put(x, t0 + b * BEAT, 0.7, -0.1)
            put(x, t0 + b * BEAT + BEAT * 0.75, 0.16, 0.5)

# pad and bass duck under the kick: applied to the whole mix lightly (drums included: it is subtle)
L *= 0.75 + 0.25 * duck
R *= 0.75 + 0.25 * duck

# risers into the busy part and into the drop; an impact on the drop and on the closing card
for bar_to, g in ((12, 0.10), (drop_bar, 0.2)):
    n = int(2 * BAR * SR)
    t = np.arange(n) / n
    x = hp(rng.standard_normal(n), 400)
    b, a = butter(2, [0.02, 0.08], 'band')
    x = lfilter(b, a, x) * 3 + 0.3 * x
    put(x * t ** 2.5, bar_to * BAR - 2 * BAR, g, 0)
for bar_at, g in ((drop_bar, 0.5), (END, 0.6)):
    n = int(2.5 * SR)
    t = np.arange(n) / SR
    put(lp(rng.standard_normal(n), 1800) * np.exp(-t * 2.2), bar_at * BAR, g * 0.5, 0)
    put(np.sin(2 * np.pi * 41 * t) * np.exp(-t * 3), bar_at * BAR, g * 0.5, 0)

# a touch of room: a short feedback delay network, then the master
def room(x):
    y = np.zeros_like(x)
    for d, g in ((0.031, 0.5), (0.047, 0.42), (0.071, 0.34), (0.103, 0.26), (0.149, 0.2)):
        k = int(d * SR)
        y[k:] += lp(x, 4000)[:-k] * g
    return y

wetL, wetR = room(R), room(L)
L += 0.16 * wetL
R += 0.16 * wetR
L, R = L[:N + SR], R[:N + SR]
fade = np.ones(len(L))
fo = int(1.6 * SR)
fade[N - fo:N] = np.cos(np.linspace(0, np.pi / 2, fo)) ** 2
fade[N:] = 0
fade[:int(0.02 * SR)] = np.linspace(0, 1, int(0.02 * SR))
L, R = hp(L, 28) * fade, hp(R, 28) * fade
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = np.tanh(L / peak * 1.6) / np.tanh(1.6), np.tanh(R / peak * 1.6) / np.tanh(1.6)
pcm = (np.stack([L[:N], R[:N]], 1) * 0.89 * 32767).astype('<i2')
with wave.open(OUT, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', OUT, f'{DUR:.1f} s, bar {BAR:.3f} s ({240 / BAR:.1f} BPM), drop at bar {drop_bar} = {drop_bar * BAR:.1f} s')
