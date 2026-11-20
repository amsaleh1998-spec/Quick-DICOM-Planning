"""Music for the narrated cut: an original bed synthesised here (no samples, nothing licensed).

  python3 music_tour.py <video.vo.json> <out.wav>

About 129 beats a minute in F major, moving all the time without hurrying: a synth pulse in even
eighth notes, straight hats, a clap on two and four, a kick that leaves room, a long deep bass,
warm electric-piano chords (one every two bars) and a gliding sine lead that answers between the
lines. A few bars of music alone open it; parts come in where the video's scenes start (from the
.vo.json the editor writes), the lead takes the tune for the 3D shot, one chord rings under the
closing card.
"""
import json, sys, wave
import numpy as np
from scipy.signal import butter, lfilter

SR = 48000
info = json.load(open(sys.argv[1]))
DUR = info['seconds']; T = info['starts']
BARS = int(round(DUR / (240 / 129.5)))  # bars of four beats
BAR = DUR / BARS; BEAT = BAR / 4; E8 = BEAT / 2
N = int(DUR * SR)
rng = np.random.default_rng(8)
L = np.zeros(N + SR * 5); R = np.zeros(N + SR * 5)
note = lambda n: 440.0 * 2 ** ((n - 69) / 12)
bar_of = lambda t: int(round(t / BAR))
# Fmaj9, Dm9, Bbmaj7, C9sus: (bass note, chord)
CH = [(29, [57, 60, 64, 67]), (38, [57, 60, 65, 64]), (34, [58, 62, 65, 69]), (36, [58, 62, 65, 67])]


def lp(x, hz, o=2):
    b, a = butter(o, min(0.45, hz / (SR / 2)), 'low'); return lfilter(b, a, x)


def hp(x, hz, o=2):
    b, a = butter(o, hz / (SR / 2), 'high'); return lfilter(b, a, x)


def put(x, t, g=1.0, pan=0.0):
    i = int(t * SR); n = min(len(x), len(L) - i)
    if n <= 0 or i < 0: return
    L[i:i + n] += x[:n] * g * np.sqrt(1 - pan); R[i:i + n] += x[:n] * g * np.sqrt(1 + pan)


def sub(f, dur, slide=0.0):
    """A long, round bass note that can slide up into its pitch; a little drive so it is heard on small speakers."""
    n = int(dur * SR); t = np.arange(n) / SR
    fr = f * (1 - slide * np.exp(-t * 14))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    x = np.tanh(1.8 * (np.sin(ph) + 0.25 * np.sin(2 * ph)))
    return x * np.minimum(1, t / 0.012) * np.minimum(1, (dur - t) / 0.08) * (0.55 + 0.45 * np.exp(-t * 1.6))


def keys(f, dur, vel=1.0):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t + 0.8 * vel * np.exp(-t * 4) * np.sin(2 * np.pi * f * t) + 0.1 * np.exp(-t * 10) * np.sin(2 * np.pi * 14 * f * t))
    return x * (1 + 0.08 * np.sin(2 * np.pi * 3.2 * t)) * np.exp(-t * 0.9) * np.minimum(1, t / 0.008) * np.minimum(1, (dur - t) / 0.12) * vel


def lead(notes, beat):
    """A sine that glides from note to note (the whistle of west-coast records): [(beat, beats long, midi)]."""
    end = max(b + d for b, d, _ in notes); n = int(end * beat * SR); t = np.arange(n) / SR
    f = np.zeros(n); g = np.zeros(n)
    for b, d, m in notes:
        i, j = int(b * beat * SR), int((b + d) * beat * SR); f[i:] = note(m); g[i:j] = 1
    k = int(0.07 * SR); f = np.convolve(np.pad(f, (k, 0), mode='edge'), np.ones(k) / k, 'valid')[:n]  # the glide
    g = lp(g, 14, 1)
    vib = 1 + 0.006 * np.sin(2 * np.pi * 5.3 * t)
    ph = 2 * np.pi * np.cumsum(f * vib) / SR
    return (np.sin(ph) + 0.18 * np.sin(2 * ph) + 0.06 * np.sin(3 * ph)) * g


def pulse(f, vel=1.0, bright=1800):
    """One note of the pulse: a short, muted synth pluck."""
    n = int(0.21 * SR); t = np.arange(n) / SR
    x = (2 * ((f * t) % 1) - 1) + 0.6 * (2 * ((f * 1.004 * t + 0.3) % 1) - 1)
    return lp(x, bright) * np.exp(-t * 17) * np.minimum(1, t / 0.003) * vel * 0.5


def kick():
    n = int(0.42 * SR); t = np.arange(n) / SR
    return np.tanh(1.5 * np.sin(2 * np.pi * np.cumsum(44 + 95 * np.exp(-t * 26)) / SR)) * np.exp(-t * 7.5)


def clap():
    n = int(0.3 * SR); t = np.arange(n) / SR
    x = hp(lp(rng.standard_normal(n), 5200), 800)
    e = sum(np.exp(-np.maximum(t - d, 0) * 38) * (t >= d) for d in (0, 0.012, 0.026)) / 3
    return x * e + 0.25 * np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)


def hat(v, open_=False):
    n = int((0.2 if open_ else 0.05) * SR); t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7000) * np.exp(-t * (16 if open_ else 80)) * v


def pad(freqs, dur):
    n = int((dur + 1.5) * SR); t = np.arange(n) / SR; x = np.zeros(n)
    for f in freqs:
        for d in (-0.005, 0.0, 0.005):
            x += 2 * (((f * (1 + d)) * t + rng.random()) % 1) - 1
    return lp(x, 1200, 2) / (3 * len(freqs)) * np.minimum(1, t / 1.2) * np.minimum(1, np.maximum(0, (dur + 1.5 - t) / 1.5))


# where the parts change: from the editor ("music": drums, tune, out) or from the implant demo's scenes
M = info.get('music', {})
b_beat = max(4, bar_of(M.get('drums', T.get('open', 3.6) + 8)) // 2 * 2)   # the drums, once the opening lines are said
b_hero = bar_of(M.get('tune', T.get('hero', 80))) // 2 * 2                  # the lead takes the tune (the 3D shot)
b_out = bar_of(M.get('out', T.get('report', 92))) // 2 * 2
END = bar_of(T.get('outro', DUR - 5))
# the lead, per chord, over two bars (beats, beats long, note): answers between the lines, the tune over the 3D shot
ANSWER = [[(5, 1, 81), (6, 2, 84)], [(4, 1, 81), (5, 1, 77), (6, 2, 76)], [(5, 1, 77), (6, 2, 81)], [(4, 1, 79), (5, 1, 82), (6, 2, 84)]]
TUNE = [[(0, 3, 84), (3, 1, 81), (4, 2, 84), (6, 2, 88)], [(0, 3, 86), (3, 1, 84), (4, 4, 81)], [(0, 3, 82), (3, 1, 81), (4, 2, 77), (6, 2, 81)], [(0, 2, 79), (2, 2, 82), (4, 4, 84)]]
# the pulse: which chord tone each eighth of a bar plays (and an octave up on some)
ARP = [(0, 0), (2, 0), (1, 0), (2, 0), (3, 0), (2, 0), (1, 0), (2, 12)]

for bar in range(BARS):
    t0 = bar * BAR
    ci = (bar // 2) % 4
    root, tones = CH[ci]
    first = bar % 2 == 0  # the first of the chord's two bars
    if bar >= END:
        if bar == END:
            for k, m in enumerate(CH[0][1] + [72]):
                put(keys(note(m), 6.0, 0.8), t0 + 0.03 * k, 0.15, -0.3 + 0.15 * k)
            put(sub(note(29), 4.0), t0, 0.3)
            put(pad([note(m) for m in CH[0][1]], 4.0), t0, 0.5)
        continue
    hero = b_hero <= bar < b_out
    beat = b_beat <= bar < b_out + 2
    if first:
        put(pad([note(m) for m in tones], 2 * BAR), t0, 0.36 if not beat else 0.24)
        # chords: rolled on the one of the first bar, a softer one before the second
        for h, v in ((0, 0.85), (3.5, 0.5), (6.5, 0.45)):
            for k, m in enumerate(tones):
                put(keys(note(m), BAR * 0.9, v), t0 + h * BEAT + 0.018 * k, 0.17, -0.35 + 0.23 * k)
        if bar >= 2:
            put(sub(note(root), BEAT * 5.2, 0.12 if ci % 2 == 0 else 0.0), t0, 0.26)
            put(sub(note(root + 7), BEAT * 1.6), t0 + 5.5 * BEAT, 0.2)
            if ci == 3:
                put(sub(note(root + 2), BEAT * 0.8, 0.1), t0 + 7.25 * BEAT, 0.2)
    # the pulse: even eighths from the start, opening up as the piece goes on
    open_ = 1300 + 1900 * min(1.0, bar / max(1, b_hero)) + (900 if hero else 0)
    for k, (ti, up) in enumerate(ARP):
        put(pulse(note(tones[ti] + up), 1.0 if k % 2 == 0 else 0.8, open_), t0 + k * E8, 0.42 if bar >= 2 else 0.3, 0.28 * (-1) ** k)
    if beat:
        for b in ((0, 2.5) if first else (0, 1.5, 2.5)):
            put(kick(), t0 + b * BEAT, 0.4)
        for b in (1, 3):
            put(clap(), t0 + b * BEAT, 0.36, 0.08)
        for k in range(8):
            put(hat(0.9 if k % 2 == 0 else 0.6, open_=(k == 7 and not first and ci == 3)), t0 + k * E8, 0.12, 0.35)
    elif bar >= 2:
        for k in range(8):  # hats alone before the drums
            put(hat(0.7 if k % 2 == 0 else 0.45), t0 + k * E8, 0.07, 0.35)
    if first:
        if hero:
            put(lead(TUNE[ci], BEAT), t0, 0.075, -0.1)
        elif beat and ci % 2 == 1 and bar < b_hero - 2:
            put(lead(ANSWER[ci], BEAT), t0, 0.055, 0.25)

# into the drums and into the 3D shot: a reversed swell
for bb, g in ((b_beat, 0.05), (b_hero, 0.07)):
    n = int(2 * BAR * SR); put(hp(lp(rng.standard_normal(n), 5000), 400) * (np.arange(n) / n) ** 3, bb * BAR - 2 * BAR, g)


def room(x):
    y = np.zeros_like(x)
    for d, g in ((0.029, 0.36), (0.043, 0.3), (0.061, 0.24), (0.089, 0.18), (0.127, 0.12)):
        k = int(d * SR); y[k:] += lp(x, 3800)[:-k] * g
    return y
wl, wr = room(R), room(L)
L += 0.25 * wl; R += 0.25 * wr
tilt = lambda x: x + 1.1 * hp(x, 700, 1) + 0.9 * hp(x, 2500, 1)
L, R = lp(tilt(hp(L[:N], 28)), 12000, 1), lp(tilt(hp(R[:N], 28)), 12000, 1)
fade = np.ones(N); fo = int(2.6 * SR); fade[-fo:] = np.cos(np.linspace(0, np.pi / 2, fo)) ** 2; fade[:480] = np.linspace(0, 1, 480)
L *= fade; R *= fade
pk = max(abs(L).max(), abs(R).max()); L, R = np.tanh(L / pk * 1.3) / np.tanh(1.3), np.tanh(R / pk * 1.3) / np.tanh(1.3)
with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.stack([L, R], 1) * 0.85 * 32767).astype('<i2').tobytes())
print(f'wrote {sys.argv[2]}: {DUR:.1f} s, {BARS} bars, {240 / BAR:.1f} BPM; drums from bar {b_beat}, 3D {b_hero}, out {b_out}, end {END}')
