"""The voiceover of the dual scan video (the narrator of vo_script_tour.py; see vo_script.py for the fields)."""
VOICE = 3  # Kokoro "af_heart"
SPEED = 0.9
# the title card a little longer (music alone, then the first line), the window with the markers held
HOLDS = {'intro': 1.2, 'dscan.window': 3.5}
LINES = [
    ('intro+1.5', 'This is the dual scan protocol.', None),
    ('file+0.3', "Double-click a DICOM file, and the patient's scan opens in quickdicom.app.", "Double-click a dicom file, and the patient's scan opens in quick dicom dot app."),
    ('dopen.loaded', 'The patient was scanned wearing the denture, with small radiopaque markers on it.', None),
    ('dcurve+0.5', 'One stroke along the arch, and the panoramic view is there.', None),
    ('dscan+0.3', 'Then comes the second scan: the denture, on its own.', None),
    ('dscan.window+0.2', 'The markers in both scans are found and matched automatically. Six of six. Nothing to click, and nothing to line up.', None),
    ('dclean+0.5', 'Turn the denture over, and there is an artifact from the scan.', None),
    ('dclean.below+0.2', 'The cut brush frees it, only where the two touch.', None),
    ('dclean.cut+0.4', 'Remove the island, close the hole,', None),
    ('dclean.holes+0.8', 'and let the smooth brush finish the surface.', None),
    ('dplace+0.3', "One click places the denture in the patient's scan,", None),
    ('dplace.placed+0.4', 'exactly where the markers put it.', None),
    ('dslices.start', 'Slice after slice, it follows the ridge.', None),
    ('d3d+0.6', 'And in 3D, denture and jaw are finally in one place.', 'And in three D, denture and jaw are finally in one place.'),
    ('outro+0.5', 'The dual scan protocol, reimagined for the browser.', None),
    ('outro', 'quickdicom.app.', 'Quick dicom, dot app.'),
]
