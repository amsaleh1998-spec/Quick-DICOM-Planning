"""A second voiceover of the implant demo: a narrator who shows the place round – longer sentences,
pairs of things, unhurried. (See vo_script.py for what the fields are.)"""
VOICE = 3  # Kokoro "af_heart"
SPEED = 0.9
# pictures held (s): the title card with the music alone, the start screen under the opening lines, the alignment window
HOLDS = {'intro': 1.6, 'open': 11.4, 'scans.window': 3.2}
LINES = [
    ('open+0.3', "With quickdicom.app, we've tried to rethink implant planning in a number of ways.", "With quick dicom dot app, we've tried to rethink implant planning in a number of ways."),
    ('open', 'It runs entirely in your browser. Nothing to install, and nothing to upload.', None),
    ('open.dropped', 'A CBCT opens straight from your computer, and stays there.', None),
    ('ai+0.3', 'Its AI finds the jaws and the teeth on its own, right on your machine.', None),
    ('scans+0.3', 'Bring in the upper jaw scan,', None),
    ('scans.window+0.2', 'and the upper teeth are already selected for you. No lists, and no guessing.', None),
    ('scans.patches', 'Three points on the scan, the same three on the CBCT, and the two become one.', 'Three points on the scan, the same three on the C B C T, and the two become one.'),
    ('scans.matched+0.2', 'A color map shows how closely they fit.', None),
    ('curve+0.5', 'One stroke along the arch gives you the panoramic view, and cross sections all the way around it.', None),
    ('implants+0.6', 'The implants are real ones, from your own library: brands and systems, diameters and lengths.', None),
    ('implants.sized24+0.3', 'Position and angle are set right in the sections,', None),
    ('implants.tilted24+0.3', 'and multi-unit abutments follow, with their prosthetic axes.', 'and multi unit abutments follow, with their prosthetic axes.'),
    ('hero+0.6', 'Then the whole plan comes together in 3D:', 'Then the whole plan comes together in three D:'),
    ('hero.scanHidden', 'bone and teeth, scans and implants, exactly where you put them.', None),
    ('report+0.4', 'And the planning report writes itself.', None),
    ('outro+0.5', 'Implant planning, reimagined for the browser.', None),
    ('outro', 'quickdicom.app.', 'Quick dicom, dot app.'),
]
