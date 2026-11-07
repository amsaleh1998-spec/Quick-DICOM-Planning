#!/usr/bin/env python3
"""Cross-check the anonymizer with pydicom (development only).

    pip install pydicom numpy
    go build -o /tmp/dicom-anon . && python3 testing/check_pydicom.py /tmp/dicom-anon

Writes sample files in every supported encoding (with names in nested sequences, private tags, overlays,
compressed pixel data, a raw file without preamble and a DICOMDIR), runs the command-line build and checks
the output with pydicom: readable, identifying data gone, pixel data unchanged, UIDs replaced consistently.
"""
import os, subprocess, sys, tempfile
import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import (ExplicitVRLittleEndian, ImplicitVRLittleEndian, ExplicitVRBigEndian,
                         DeflatedExplicitVRLittleEndian, JPEGBaseline8Bit, generate_uid)
from pydicom.encaps import encapsulate

NAME, PID = "Doe^Johnathan", "PX-778899"
STUDY, SERIES, FOR = generate_uid(), generate_uid(), generate_uid()


def sample(i, ts, compressed=False):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    sop = generate_uid()
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ts
    meta.SourceApplicationEntityTitle = "SECRET_AE"
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = sop
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = STUDY, SERIES, FOR
    ds.PatientName, ds.PatientID = NAME, PID
    ds.PatientBirthDate, ds.PatientSex, ds.PatientAge = "19700412", "M", "055Y"
    ds.OtherPatientNames = "Johnny Doe"
    ds.InstitutionName, ds.InstitutionAddress = "Smile Dental Clinic", "1 Main St"
    ds.ReferringPhysicianName = "Dr^Who"
    ds.OperatorsName = "Tech^Tina"
    ds.StudyDate, ds.StudyTime, ds.SeriesDate, ds.ContentDate = "20260101", "101010", "20260101", "20260101"
    ds.AccessionNumber, ds.StudyID = "ACC123", "ST1"
    ds.StudyDescription, ds.SeriesDescription = "CBCT for Doe", "Mandible"
    ds.StationName, ds.DeviceSerialNumber = "CBCT-ROOM-2", "SN-0001"
    ds.Modality, ds.Manufacturer = "CT", "ACME"
    ds.SeriesNumber, ds.InstanceNumber = 3, i + 1
    ds.ImagePositionPatient = [0, 0, float(i)]
    ds.PixelSpacing, ds.SliceThickness = [0.3, 0.3], 0.3
    ref = Dataset()
    ref.ReferencedSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    ref.ReferencedSOPInstanceUID = sop
    inner = Dataset()
    inner.PersonName = "Nested^Person"
    inner.CodeValue = "X"
    ref.ContentSequence = Sequence([inner])  # (0040,A730) inside an item
    ds.ReferencedImageSequence = Sequence([ref])
    rp = Dataset()
    rp.PatientName = NAME  # name repeated in a sequence
    ds.ReferencedPatientSequence = Sequence([rp])
    ds.add_new(0x00091010, "LO", "ACME 1")
    ds.add_new(0x00091011, "LO", NAME)  # private tag holding the name
    ds[0x00091010].value = "ACME 1"
    ds.add_new(0x60000010, "US", 4)
    ds.add_new(0x60000011, "US", 4)
    ds.add_new(0x60003000, "OW", b"\0" * 2)
    ds.Rows = ds.Columns = 4
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    if compressed:
        ds.BitsAllocated = ds.BitsStored = 8
        ds.HighBit, ds.PixelRepresentation = 7, 0
        ds.PixelData = encapsulate([bytes(range(i, i + 16)), b"\xAB\xCD"])
        ds["PixelData"].VR = "OB"
    else:
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 12, 11, 0
        arr = (np.arange(16, dtype=np.uint16) + i * 100).reshape(4, 4)
        ds.PixelData = arr.astype(">u2" if ts == ExplicitVRBigEndian else "<u2").tobytes()
    return ds


def main(exe):
    work = tempfile.mkdtemp(prefix="anon-check-")
    src = os.path.join(work, "DOE_JOHNATHAN")
    os.makedirs(os.path.join(src, "sub"))
    originals = {}
    variants = [("impl", ImplicitVRLittleEndian, False), ("expl", ExplicitVRLittleEndian, False),
                ("be", ExplicitVRBigEndian, False), ("defl", DeflatedExplicitVRLittleEndian, False),
                ("jpeg", JPEGBaseline8Bit, True)]
    for i, (tag, ts, comp) in enumerate(variants):
        ds = sample(i, ts, comp)
        p = os.path.join(src, "sub" if i % 2 else "", f"{tag}_{NAME}.dcm")
        if ts == ExplicitVRBigEndian:
            ds._read_little, ds._read_implicit = False, False  # dataset "was read" big endian
        pydicom.dcmwrite(p, ds, enforce_file_format=True)
        originals[ds.SOPInstanceUID] = (tag, ds)
    # raw implicit VR data set without preamble/meta
    ds = sample(9, ImplicitVRLittleEndian)
    raw = os.path.join(src, "IM_RAW")
    del ds.file_meta
    ds.preamble = None
    pydicom.dcmwrite(raw, ds, implicit_vr=True, little_endian=True)  # no preamble, no file meta
    with open(raw, "rb") as fh:
        assert fh.read(132)[128:132] != b"DICM"
    originals[ds.SOPInstanceUID] = ("raw", ds)
    # DICOMDIR and a text file must be left out
    dd = Dataset()
    dd.add_new(0x00041220, "SQ", Sequence([Dataset()]))
    dd[0x00041220].value[0].PatientName = NAME
    dd.file_meta = FileMetaDataset()
    dd.file_meta.MediaStorageSOPClassUID = "1.2.840.10008.1.3.10"
    dd.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    dd.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dd.preamble = b"\0" * 128
    dd.save_as(os.path.join(src, "DICOMDIR"), enforce_file_format=True)
    with open(os.path.join(src, "notes.txt"), "w") as fh:
        fh.write("Johnathan Doe\n")

    out = os.path.join(work, "out")
    r = subprocess.run([exe, "-out", out, src], capture_output=True, text=True)
    print(r.stderr)
    assert r.returncode == 0, r.returncode

    written = []
    for root, _, files in os.walk(out):
        for f in files:
            written.append(os.path.join(root, f))
    assert len(written) == len(originals), written
    assert all(NAME.split("^")[0].upper() not in p.upper() for p in written), written
    study, series = set(), set()
    for p in sorted(written):
        blob = open(p, "rb").read()
        ds = pydicom.dcmread(p)
        assert blob[128:132] == b"DICM", p
        assert str(ds.PatientName) == "ANONYMOUS" and ds.PatientID == "ANON", p
        assert ds.PatientBirthDate == "" and ds.StudyDate == "" and "SeriesDate" not in ds
        for kw in ["OtherPatientNames", "InstitutionName", "InstitutionAddress", "OperatorsName", "StationName",
                   "DeviceSerialNumber", "StudyDescription", "SeriesDescription", "PatientAge",
                   "ReferencedPatientSequence"]:
            assert kw not in ds, (p, kw)
        assert ds.ReferringPhysicianName == "" and ds.AccessionNumber == "" and ds.PatientSex == ""
        assert not any(e.tag.is_private for e in ds), p
        assert 0x60000010 not in ds and 0x60003000 not in ds
        assert ds.PatientIdentityRemoved == "YES"
        assert "ContentSequence" not in ds.ReferencedImageSequence[0]
        assert ds.file_meta.MediaStorageSOPInstanceUID == ds.SOPInstanceUID
        assert "SourceApplicationEntityTitle" not in ds.file_meta
        assert ds.SOPInstanceUID.startswith("2.25.") and ds.SOPInstanceUID not in originals
        assert ds.ReferencedImageSequence[0].ReferencedSOPInstanceUID == ds.SOPInstanceUID
        assert ds.SOPClassUID == "1.2.840.10008.5.1.4.1.1.2"
        assert ds.ReferencedImageSequence[0].ReferencedSOPClassUID == "1.2.840.10008.5.1.4.1.1.2"
        study.add(ds.StudyInstanceUID); series.add(ds.SeriesInstanceUID)
        assert ds.Manufacturer == "ACME" and ds.Modality == "CT"
        for raw_text in [b"Doe", b"DOE", b"Johnathan", b"Smile", PID.encode(), b"Tina", b"SECRET_AE", b"Nested"]:
            assert raw_text not in blob or ds.file_meta.TransferSyntaxUID == DeflatedExplicitVRLittleEndian, (p, raw_text)
        # match the original by instance number and compare pixel data
        orig = next(o for t, o in originals.values() if o.InstanceNumber == ds.InstanceNumber)
        assert ds.file_meta.TransferSyntaxUID == (orig.file_meta.TransferSyntaxUID if "TransferSyntaxUID" in getattr(orig, "file_meta", {}) else ImplicitVRLittleEndian), p
        assert ds.PixelData == orig.PixelData, p
        assert list(ds.ImagePositionPatient) == list(orig.ImagePositionPatient)
    assert len(study) == 1 and len(series) == 1 and STUDY not in study, (study, series)
    print(f"OK: {len(written)} files checked in {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/dicom-anon")
