# Demo video

Records the app being used on a CBCT – drop the scan in, automatic segmentation, intraoral scans,
panoramic curve, two implants from the library, 3D, planning report – and edits the recording into
a one-minute video (1920 × 1080, 60 fps): camera moves, pointer, captions, title cards.

Everything on screen is the real app, driven with real mouse, keyboard and drag-and-drop events.
The scan is not part of the repository: pass the folder with the DICOM series and the two
intraoral scans (`upper.stl`, `lower.stl`). `lib/plan.cjs` holds what was worked out for one
particular scan (where the arch runs, where the implants go, how the scan lies in the CBCT) – for
another scan, change it.

## How it works

- **Frame by frame, not in real time.** The page's clock is stepped by hand, one video frame at a
  time (timers, `requestAnimationFrame`, CSS and Web-Animations animations), and a screenshot is
  taken after every step. The video is smooth however long a frame takes to draw – without a
  graphics card the 3D view is ray-cast in software and needs seconds per frame.
- **Waits are recorded in real time** (loading the scan, the automatic segmentation, extracting
  the CBCT surface, the report) and sampled; the edit plays them as a time-lapse and labels the
  long ones.
- **The pointer is drawn by the editor** from the logged mouse positions and cursor shapes (a
  screenshot has no pointer), with click ripples and the files being dragged in.
- **The app's `<select>` lists are drawn in the page for the recording** (`appearance:
  base-select`, added by `lib/stage.cjs`): the native list is drawn by the operating system and
  never reaches a screenshot. Same options, same behaviour.

## Record

```bash
npm run build
node tools/demo-video/serve.cjs &          # dist/ on http://127.0.0.1:4174/
cd tools/demo-video
node capture.cjs --data "/path/to/Demo CBCT" --library /path/to/library.qdplib --out out/rec --checkpoints \
  --scenes open,ai,scans,curve,implants,hero,report
```

- `--library`: the implant library file the implants are chosen from. It is imported before the
  recording starts, as it is in a browser that has had it imported before (the library is private
  and not part of the repository).
- `--preview` records small and fast (1×, 30 fps; with `--draft3d` the 3D scene at the app's
  draft quality) to check the choreography.
- `--checkpoints` saves a project after each scene. A scene can then be recorded again on its
  own: `--from out/rec/scans.qdp.zip --rail segments --fit --scenes curve,implants --out out/rec2`
  (`--rail`: the side panel a continuous session would have open at that point; `--fit`: for a
  project saved before its planning views were ever shown).
- Without a graphics card a full recording (2×, 60 fps) takes about two hours: over an hour of it
  is the 3D scene (about ten seconds per frame), ten minutes the automatic segmentation on the CPU.

`python3 review.py out/rec [cols rows [from to]]` writes a contact sheet of a recording and lists
its scenes, clicks and waits with their frame numbers.

## Edit

```bash
python3 compose/edit.py out/rec --out demo.mp4
python3 compose/edit.py out/rec --out rough.mp4 --scale 0.5 --preset veryfast --crf 23
python3 compose/edit.py out/rec --stills out/stills --times 12.5,31      # single frames
python3 timeline.py out/rec                  # scene and caption times, fastest camera moves
```

The video is encoded with a silent audio track. `compose/music.py` synthesises an original
soundtrack of the same length (electronic, 32 bars that build up to the 3D shot; nothing sampled or licensed):

```bash
python3 compose/music.py 70.6 music.wav 53.4        # length of the video, start of the 3D shot (s)
ffmpeg -i demo.mp4 -i music.wav -map 0:v -map 1:a -c:v copy -af loudnorm=I=-16:TP=-1.5 -c:a aac -b:a 192k demo-music.mp4
```

Several recordings can be given; a scene in a later one replaces the same scene of an earlier
one (`edit.py out/rec out/rec2`).

| File | Purpose |
| --- | --- |
| `lib/stage.cjs` | The recorder: stepped clock, screenshots, mouse paths, file drags, the log |
| `scenes.cjs`, `lib/plan.cjs` | What is done in the app, scene by scene, and the plan for the scan |
| `capture.cjs`, `serve.cjs` | Runs scenes; serves `dist/` with the headers the app's service worker adds |
| `compose/edit.py` | The edit: cuts, speeds, camera, captions |
| `compose/engine.py` | Draws the frames (window, camera, pointer, captions) and encodes them |
| `compose/cards.py`, `compose/cursors.py` | Title cards; the pointer shapes |
| `compose/music.py` | The soundtrack, synthesised |

## Needs

Node with the repository's dev dependencies (Playwright and its Chromium), Python 3 with `numpy`,
`opencv-python-headless`, `Pillow` and `scipy` (music), `ffmpeg`, `pdftoppm` (poppler, for the report pages) and
the Inter font (DejaVu Sans is used when it is missing).

## The dual scan video

`dual.cjs` (scenes `dopen, dcurve, dscan, dclean, dplace, dslices, d3d`), `lib/plan-dual.cjs` and
`compose/edit_dual.py` are a second video on the same recorder: the dual scan protocol on a case
with two CBCTs (`--data` is the folder that holds `patient with denture/` and `denture only/`).

```bash
node capture.cjs --data "/path/to/Dual Scan Example" --out out/dual --scenes dopen,dcurve,dscan,dclean,dplace,dslices,d3d
python3 compose/edit_dual.py out/dual --out dual.mp4
python3 compose/music.py 72.8 music.wav 63.6          # length of the video, start of the 3D shot (s)
```

The window with the DICOM files at the start is an illustration drawn by the editor (the app is
opened by a double-click on a file only where it is installed); everything after it is the app.

## The cut with a voiceover

The implant demo with a narrator: the lines are in `compose/vo_script.py` (what is said, the point
of the video each line belongs to, and how names are spelled for the speech engine), spoken by
`compose/voice.py` (Kokoro through `sherpa-onnx`; the model is a download of its own). The editor
then paces the video for them – every scene a little slower, slower still or held where a line
needs the time – and writes when each line starts; `compose/music_vo.py` makes a music bed that
follows the scenes and `compose/mix.py` puts the voice on it, the music held down under the voice.

```bash
python3 compose/voice.py /path/to/kokoro-multi-lang-v1_0 vo             # vo/line00.wav ..., vo/lines.json
python3 compose/edit.py out/rec --vo vo/lines.json --out demo-vo.mp4    # also writes demo-vo.mp4.vo.json
python3 compose/music_vo.py demo-vo.mp4.vo.json music.wav
python3 compose/mix.py demo-vo.mp4.vo.json vo music.wav sound.wav
ffmpeg -i demo-vo.mp4 -i sound.wav -map 0:v -map 1:a -c:v copy -af loudnorm=I=-16:TP=-1.5 -c:a aac -b:a 192k demo-voiceover.mp4
```

The speech engine leaves out words it does not know: `voice.py` stops and names them, so that they
can be added to `compose/vo_lexicon.txt` (word, then its sounds as the engine writes them) or
respelled in the script.

A second narration is `compose/vo_script_tour.py` (another voice, longer sentences) with the bed
of `compose/music_tour.py`: `voice.py <model> vo2 vo_script_tour`, then the same steps.

The dual scan video has its narration too (`compose/vo_script_dual.py`, the same voice and bed):
`voice.py <model> vo3 vo_script_dual`, `edit_dual.py out/dual --vo vo3/lines.json --out dual-vo.mp4`,
then `music_tour.py` and `mix.py` on `dual-vo.mp4.vo.json`.

