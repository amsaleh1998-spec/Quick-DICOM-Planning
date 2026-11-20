"""Music for the narrated cut, laid back: an original bed synthesised here (no samples, nothing licensed).

  python3 music_laidback.py <video.vo.json> <out.wav>

About 65 beats a minute with a half-time beat, F major, deep and unhurried: a long sub bass, warm
electric-piano chords, a kick and a clap that leave room, soft hats, and a gliding sine lead that
answers between the lines. Two bars of music alone open it; parts come in where the video's scenes
start (from the .vo.json the editor writes), the lead takes over for the 3D shot, one chord rings
under the closing card.
"""
import json, sys, wave
import numpy as np
from scipy.signal import butter, lfilter

SR = 48000
info = json.load(open(sys.argv[1]))
DUR = info['seconds']; T = info['starts']
BARS = int(round(DUR / (240 / 65)))
BAR = DUR / BARS; BEAT = BAR / 4; S16 = BEAT / 4
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


b_beat = max(2, bar_of(T.get('open', 3.6) + 8))   # the beat, once the opening lines are said
b_hats = bar_of(T.get('scans', 30))
b_hero = bar_of(T.get('hero', 80))
b_out = bar_of(T.get('report', 92))
END = bar_of(T.get('outro', DUR - 5))
# answers of the lead, one for each chord (beats in the bar, beats long, note), played every other time round
ANSWER = [[(2.5, 0.5, 81), (3, 1, 84)], [(2, 0.5, 81), (2.5, 0.5, 77), (3, 1, 76)], [(2.5, 0.5, 77), (3, 1, 81)], [(2, 0.5, 79), (2.5, 0.5, 82), (3, 1, 84)]]
TUNE = [[(0, 1.5, 84), (1.5, 0.5, 81), (2, 1, 84), (3, 1, 88)], [(0, 1.5, 86), (1.5, 0.5, 84), (2, 2, 81)], [(0, 1.5, 82), (1.5, 0.5, 81), (2, 1, 77), (3, 1, 81)], [(0, 1, 79), (1, 1, 82), (2, 2, 84)]]

for bar in range(BARS):
    t0 = bar * BAR
    root, tones = CH[bar % 4]
    if bar >= END:
        if bar == END:
            for k, m in enumerate(CH[0][1] + [72]):
                put(keys(note(m), 6.0, 0.8), t0 + 0.03 * k, 0.15, -0.3 + 0.15 * k)
            put(sub(note(29), 4.0), t0, 0.34)
            put(pad([note(m) for m in CH[0][1]], 4.0), t0, 0.5)
        continue
    hero = b_hero <= bar < b_out
    beat = b_beat <= bar < b_out + 1
    put(pad([note(m) for m in tones], BAR), t0, 0.42 if not beat else 0.3)
    # chords: rolled on the one, a softer one on the and of three
    for h, v in ((0, 0.85), (2.5, 0.55)):
        for k, m in enumerate(tones):
            put(keys(note(m), BAR * 0.62, v), t0 + h * BEAT + 0.022 * k, 0.2, -0.35 + 0.23 * k)
    if bar >= 1:
        put(sub(note(root), BEAT * 2.4, 0.0 if bar % 2 else 0.12), t0, 0.26)
        put(sub(note(root + (7 if bar % 4 != 3 else 5)), BEAT * 0.9), t0 + 2.5 * BEAT, 0.2)
        if bar % 4 == 3:
            put(sub(note(root + 2), BEAT * 0.45, 0.1), t0 + 3.5 * BEAT, 0.2)
    if beat:
        for b in ((0, 1.75) if bar % 2 == 0 else (0, 1.5, 3.5)):
            put(kick(), t0 + b * BEAT, 0.4)
        put(clap(), t0 + 2 * BEAT, 0.4, 0.08)
        if bar >= b_hats:
            for k in range(16):
                sw = S16 * 0.16 if k % 2 else 0
                put(hat((0.9, 0.35, 0.6, 0.35)[k % 4], open_=(k == 14 and bar % 4 == 3)), t0 + k * S16 + sw, 0.11, 0.35)
        else:
            for k in range(8):
                put(hat(0.8 if k % 2 == 0 else 0.4), t0 + k * BEAT / 2, 0.09, 0.35)
    # the lead: the tune over the 3D shot, an answer every other bar elsewhere once the beat is in
    if hero:
        put(lead(TUNE[bar % 4], BEAT), t0, 0.075, -0.1)
    elif beat and bar % 2 == 1 and bar < b_hero - 1:
        put(lead(ANSWER[bar % 4], BEAT), t0, 0.055, 0.25)

# into the beat and into the 3D shot: a reversed swell
for bb, g in ((b_beat, 0.05), (b_hero, 0.07)):
    n = int(BAR * SR); put(hp(lp(rng.standard_normal(n), 5000), 400) * (np.arange(n) / n) ** 3, bb * BAR - BAR, g)


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
print(f'wrote {sys.argv[2]}: {DUR:.1f} s, {BARS} bars, {240 / BAR:.1f} BPM; beat from bar {b_beat}, hats {b_hats}, 3D {b_hero}, out {b_out}, end {END}')
