# Compressed test series for the DICOM loader, made with GDCM (the reference implementation).
#
#   node scripts/make-test-dicom.mjs <dir>/dcm/raw
#   pip install python-gdcm pydicom numpy
#   python3 scripts/make-compressed-dicom.py <dir>
#
# Writes <dir>/dcm/<variant>/ for JPEG Lossless (.57, .70), JPEG-LS (.80, .81), JPEG 2000 (.90, .91),
# RLE (1.2.5) and JPEG Baseline (.50), unsigned and signed, single-file and multi-frame. Every lossless
# variant must load with exactly the same voxels as the uncompressed series.
import os, sys, glob, copy
import numpy as np, pydicom, gdcm

S = sys.argv[1]
raw = sorted(glob.glob(os.path.join(S, 'dcm/raw/*.dcm')))

def convert(src, dst, ts_uid, lossy=False):
    r = gdcm.ImageReader(); r.SetFileName(src)
    assert r.Read(), src
    ch = gdcm.ImageChangeTransferSyntax()
    ch.SetTransferSyntax(gdcm.TransferSyntax(ts_uid))
    ch.SetInput(r.GetImage())
    assert ch.Change(), (ts_uid, src)
    w = gdcm.ImageWriter(); w.SetFileName(dst); w.SetFile(r.GetFile()); w.SetImage(ch.GetOutput())
    assert w.Write(), dst

variants = {
    'jpegls_sv1_70': gdcm.TransferSyntax.JPEGLosslessProcess14_1,   # 1.2.840.10008.1.2.4.70
    'jpegl_p14_57': gdcm.TransferSyntax.JPEGLosslessProcess14,      # .57
    'jpegls_80': gdcm.TransferSyntax.JPEGLSLossless,                # .80
    'j2k_90': gdcm.TransferSyntax.JPEG2000Lossless,                 # .90
    'rle_5': gdcm.TransferSyntax.RLELossless,                       # 1.2.5
}

# signed copy of the series (PixelRepresentation = 1, values shifted to go negative)
os.makedirs(os.path.join(S, 'dcm/signed_raw'), exist_ok=True)
for f in raw:
    ds = pydicom.dcmread(f)
    a = ds.pixel_array.astype(np.int32) - 1500
    ds.PixelRepresentation = 1
    ds.BitsStored = 16; ds.HighBit = 15
    ds.RescaleIntercept = 0
    ds.PixelData = a.astype(np.int16).tobytes()
    ds.save_as(os.path.join(S, 'dcm/signed_raw', os.path.basename(f)))
signed_raw = sorted(glob.glob(os.path.join(S, 'dcm/signed_raw/*.dcm')))

for name, ts in variants.items():
    for base, files in (('', raw), ('signed_', signed_raw)):
        out = os.path.join(S, 'dcm', base + name); os.makedirs(out, exist_ok=True)
        for f in files: convert(f, os.path.join(out, os.path.basename(f)), ts)

# lossy JPEG 2000 (.91) and JPEG-LS near-lossless (.81)
for name, ts in (('j2k_lossy_91', gdcm.TransferSyntax.JPEG2000), ('jpegls_near_81', gdcm.TransferSyntax.JPEGLSNearLossless)):
    out = os.path.join(S, 'dcm', name); os.makedirs(out, exist_ok=True)
    for f in raw: convert(f, os.path.join(out, os.path.basename(f)), ts)

# 8-bit series for JPEG baseline (.50)
os.makedirs(os.path.join(S, 'dcm/raw8'), exist_ok=True)
for f in raw:
    ds = pydicom.dcmread(f)
    a = ds.pixel_array.astype(np.float32)
    a8 = np.clip(a / 4096.0 * 255, 0, 255).astype(np.uint8)
    ds.BitsAllocated = 8; ds.BitsStored = 8; ds.HighBit = 7; ds.PixelRepresentation = 0
    ds.RescaleIntercept = 0; ds.RescaleSlope = 1
    ds.PixelData = a8.tobytes()
    ds.save_as(os.path.join(S, 'dcm/raw8', os.path.basename(f)))
out = os.path.join(S, 'dcm/jpeg_baseline_50'); os.makedirs(out, exist_ok=True)
for f in sorted(glob.glob(os.path.join(S, 'dcm/raw8/*.dcm'))):
    convert(f, os.path.join(out, os.path.basename(f)), gdcm.TransferSyntax.JPEGBaselineProcess1)

# multi-frame: one file with all slices, then compressed (one fragment per frame)
dss = [pydicom.dcmread(f) for f in raw]
mf = copy.deepcopy(dss[0])
mf.NumberOfFrames = len(dss)
mf.PixelData = b''.join(d.PixelData for d in dss)
# per-frame positions (functional groups)
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence
pf = []
for d in dss:
    item = Dataset(); pp = Dataset(); pp.ImagePositionPatient = d.ImagePositionPatient
    item.PlanePositionSequence = Sequence([pp]); pf.append(item)
mf.PerFrameFunctionalGroupsSequence = Sequence(pf)
del mf.ImagePositionPatient
os.makedirs(os.path.join(S, 'dcm/mf_raw'), exist_ok=True)
mf.save_as(os.path.join(S, 'dcm/mf_raw/multi.dcm'))
for name, ts in (('mf_jpegls_sv1_70', gdcm.TransferSyntax.JPEGLosslessProcess14_1), ('mf_j2k_90', gdcm.TransferSyntax.JPEG2000Lossless), ('mf_rle_5', gdcm.TransferSyntax.RLELossless)):
    out = os.path.join(S, 'dcm', name); os.makedirs(out, exist_ok=True)
    convert(os.path.join(S, 'dcm/mf_raw/multi.dcm'), os.path.join(out, 'multi.dcm'), ts)

# GDCM rewrites the per-frame positions of multi-frame files: restore the original geometry
src = pydicom.dcmread(os.path.join(S, 'dcm/mf_raw/multi.dcm'))
for name in ('mf_jpegls_sv1_70', 'mf_j2k_90', 'mf_rle_5'):
    f = os.path.join(S, 'dcm', name, 'multi.dcm')
    ds = pydicom.dcmread(f)
    ds.PerFrameFunctionalGroupsSequence = src.PerFrameFunctionalGroupsSequence
    for tag in ('PixelSpacing', 'ImageOrientationPatient', 'SliceThickness', 'SpacingBetweenSlices'):
        if tag in src: setattr(ds, tag, getattr(src, tag))
        elif tag in ds: delattr(ds, tag)
    ds.save_as(f)

for d in sorted(os.listdir(os.path.join(S, 'dcm'))):
    files = glob.glob(os.path.join(S, 'dcm', d, '*'))
    ds = pydicom.dcmread(files[0], stop_before_pixels=True)
    print(f'{d:20s} {len(files):3d} files  TS={ds.file_meta.TransferSyntaxUID}  bits={ds.BitsAllocated} signed={ds.PixelRepresentation}  frames={getattr(ds, "NumberOfFrames", 1)}')
