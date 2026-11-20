"""The soundtrack of the voiceover cut: the spoken lines on the music, the music held down under them.

  python3 mix.py <video.vo.json> <lines dir> <music.wav> <out.wav>
"""
import json, os, sys, wave
import numpy as np, soundfile as sf
from scipy.signal import butter, lfilter

SR = 48000
info = json.load(open(sys.argv[1])); d = sys.argv[2]
m, sr = sf.read(sys.argv[3]); assert sr == SR
n = len(m)
voice = np.zeros(n); talk = np.zeros(n)
for l in info['lines']:
    x, sr = sf.read(os.path.join(d, l['file'])); i = int(l['start'] * SR); k = min(len(x), n - i)
    voice[i:i + k] += x[:k]
    talk[max(0, i - int(0.12 * SR)):i + k + int(0.1 * SR)] = 1  # (the music gives way a moment before a line)
# the music's gain under the voice: down quickly, back slowly
b, a = butter(1, 3.0 / (SR / 2), 'low'); env = np.clip(lfilter(b, a, talk) * 1.15, 0, 1)
b, a = butter(1, 0.9 / (SR / 2), 'low'); slow = np.clip(lfilter(b, a, talk), 0, 1)
env = np.maximum(env, slow)
rms = lambda x: np.sqrt((x ** 2).mean())
m = m * (10 ** (-23.5 / 20) / rms(m))         # the music on its own: 23.5 dB under full scale
duck = 10 ** (-10.5 / 20)
g = 1 - (1 - duck) * env
voice = voice * (10 ** (-19.0 / 20) / rms(voice[talk > 0]))  # speech about 15 dB over the music under it
out = m * g[:, None] + voice[:, None] * 0.98
pk = abs(out).max()
if pk > 0.97: out *= 0.97 / pk
sf.write(sys.argv[4], out.astype(np.float32), SR, subtype='PCM_16')
on = talk > 0
print(f'wrote {sys.argv[4]}: voice {20 * np.log10(rms(voice[on])):.1f} dB, music under it {20 * np.log10(rms((m * g[:, None])[on])):.1f} dB, music between lines {20 * np.log10(rms((m * g[:, None])[~on])):.1f} dB, peak {20 * np.log10(abs(out).max()):.1f} dB')
