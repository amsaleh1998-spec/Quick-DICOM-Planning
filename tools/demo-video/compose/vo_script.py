"""The voiceover of the implant demo: what is said, and when.

A line: (anchor, text, spoken). `anchor` is where the line may start at the earliest – the start of
a scene ('scans'), a mark of the recording in it ('scans.window') or a card ('intro', 'outro'), plus
seconds ('scans.window+0.4'). `text` is the line as written; `spoken` is how it is spelled for the
speech engine where that differs (names and abbreviations it would not pronounce as meant).
"""
VOICE = 16  # Kokoro "am_michael"
SPEED = 0.94
# pictures held for this long (s) while lines are spoken: a scene's first one, or a point the edit knows ('scans.window')
HOLDS = {'open': 6.2, 'scans.window': 3.0}
LINES = [
    ('intro+0.5', 'This is quickdicom.app.', 'This is quick dye-com dot app.'),
    ('intro', "It's not something you install.", None),
    ('open+0.2', 'Or something you send your scans to.', None),
    ('open', "It's implant planning that just works. Right in your browser.", None),
    ('open.dropped', 'Drop in a CBCT. It never leaves your computer.', 'Drop in a C B C T. It never leaves your computer.'),
    ('ai+0.3', 'AI finds the jaw and the teeth.', 'AI finds the jaw, and the teeth.'),
    ('ai.background+1.0', 'By itself. On your machine.', None),
    ('scans+0.3', 'Now bring in the upper jaw scan.', None),
    ('scans.window+0.2', "And because it's the upper jaw, the upper teeth are already chosen for you.", None),
    ('scans.patches', 'So you click three points on the scan, and the same three on the CBCT.', 'So you click three points on the scan, and the same three on the C B C T.'),
    ('scans.matched+0.2', 'Then check the fit. Color by color.', None),
    ('scans.accepted+0.6', 'The lower scan just follows.', None),
    ('curve+0.5', 'Draw along the arch.', None),
    ('curve.drawn+0.6', "And there's your panoramic.", None),
    ('implants+0.6', 'Place an implant.', None),
    ('implants.brandList', 'Make it a real one, from your own library.', None),
    ('implants.sized24+0.3', 'Set its position, and its angle, right in the cross sections.', None),
    ('implants.tilted24+0.3', 'Add a multi-unit abutment.', 'Add a mull tee unit abutment.'),
    ('implants.mua24+0.4', 'Then do it again.', None),
    ('implants.sized26+0.2', 'A wider one, for the molar.', None),
    ('hero+0.6', 'And then, see all of it. In 3D.', 'And then, see all of it. In three D.'),
    ('hero.scanHidden', 'Bone. Teeth. Implants. Exactly where you planned them.', None),
    ('report+0.4', "When you're done, it writes the report.", None),
    ('outro+0.5', "So, yeah. It's implant planning.", None),
    ('outro', 'quickdicom.app.', 'Quick dye-com, dot app.'),
]
