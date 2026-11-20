"""Speak the lines of a voiceover script (Kokoro through sherpa-onnx): one wav per line and their lengths.

  python3 voice.py <model dir> <out dir> [script module, default vo_script]

vo_lexicon.txt holds the words the engine's own lexicon lacks.

Each line is levelled and trimmed of silence; lines.json lists file, text and seconds.
"""
import json, os, sys
import numpy as np, soundfile as sf, sherpa_onnx
from scipy.signal import butter, lfilter, resample_poly
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib
V = importlib.import_module(sys.argv[3] if len(sys.argv) > 3 else 'vo_script')
EXTRA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vo_lexicon.txt')

D, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
k = sherpa_onnx.OfflineTtsKokoroModelConfig(model=f'{D}/model.onnx', voices=f'{D}/voices.bin', tokens=f'{D}/tokens.txt', data_dir=f'{D}/espeak-ng-data', dict_dir=f'{D}/dict', lexicon=f'{EXTRA},{D}/lexicon-us-en.txt,{D}/lexicon-zh.txt')
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(kokoro=k, num_threads=4, provider='cpu'), max_num_sentences=1))
lines = []
# the engine leaves out words that are not in its lexicon: none may be
import re
lex = set(l.split()[0].lower() for f in (EXTRA, f'{D}/lexicon-us-en.txt') for l in open(f, encoding='utf8') if l.strip())
unknown = sorted({w for _, t, sp in V.LINES for w in re.findall(r"[A-Za-z']+", sp or t) if w.lower() not in lex})
if unknown:
    sys.exit(f'not in the lexicon (would be skipped): {unknown} - respell them in vo_script.py')
for i, (anchor, text, spoken) in enumerate(V.LINES):
    a = tts.generate(spoken or text, sid=V.VOICE, speed=V.SPEED)
    x = resample_poly(np.array(a.samples, dtype=np.float64), 48000, a.sample_rate)
    b, c = butter(2, 70 / 24000, 'high'); x = lfilter(b, c, x)
    # trim the silence at both ends (keep 30 ms), level to a common loudness
    e = np.sqrt(np.convolve(x * x, np.ones(480) / 480, 'same')); on = np.nonzero(e > 0.01 * e.max())[0]
    x = x[max(0, on[0] - 1440):on[-1] + 2880]
    loud = np.sqrt((x[e[max(0, on[0] - 1440):on[-1] + 2880] > 0.05 * e.max()] ** 2).mean())
    x *= 0.085 / loud
    x[:240] *= np.linspace(0, 1, 240); x[-960:] *= np.linspace(1, 0, 960)
    f = f'line{i:02d}.wav'; sf.write(os.path.join(out, f), x.astype(np.float32), 48000)
    lines.append(dict(file=f, anchor=anchor, text=text, seconds=round(len(x) / 48000, 3)))
    print(f'{i:2d} {len(x) / 48000:5.2f} s  peak {abs(x).max():.2f}  {text}')
json.dump(dict(holds=getattr(V, 'HOLDS', {}), lines=lines), open(os.path.join(out, 'lines.json'), 'w'), indent=1)
print('total', round(sum(l['seconds'] for l in lines), 1), 's of speech')
