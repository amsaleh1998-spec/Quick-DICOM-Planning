# DentalSegmentator – web version of the model

These files are the **DentalSegmentator** nnU-Net model, converted to run in the browser with
ONNX Runtime Web. They are used by Quick DICOM Planning's *Automatic segmentation (AI)*.

## Credit

**DentalSegmentator** was created by **Gauthier Dot et al.** Please cite their work:

> Dot G, et al. DentalSegmentator: robust open source deep learning-based CT and CBCT image
> segmentation. *Journal of Dentistry* (2024). doi:[10.1016/j.jdent.2024.105130](https://doi.org/10.1016/j.jdent.2024.105130)

> Isensee F, Jaeger PF, Kohl SAA, Petersen J, Maier-Hein KH. nnU-Net: a self-configuring method
> for deep learning-based biomedical image segmentation. *Nat Methods* 2021;18(2):203-211.
> doi:[10.1038/s41592-020-01008-z](https://doi.org/10.1038/s41592-020-01008-z)

- Original model: Dot G. *DentalSegmentator nnU-Net pretrained model for CBCT image
  segmentation.* Zenodo, 2024. doi:[10.5281/zenodo.10829675](https://doi.org/10.5281/zenodo.10829675)
  (`Dataset112_DentalSegmentator_v100.zip`, configuration `3d_fullres`, fold 0, `checkpoint_final.pth`).
- License: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
  These converted files are distributed under the same license.
- 3D Slicer extension by the same authors: [SlicerDentalSegmentator](https://github.com/gaudot/SlicerDentalSegmentator).

Labels: 1 upper skull (maxilla), 2 mandible, 3 upper teeth, 4 lower teeth, 5 mandibular canal.

## Changes made to the original

- The PyTorch network weights were loaded into nnU-Net's `PlainConvUNet` (as described by the
  model's `plans.json`) and exported to ONNX (opset 17), input `[1, 1, 128, 160, 112]`.
- The weights are stored as 16-bit floats (`weights16.*.bin`, split into 16 MB parts) and widened
  back to 32 bits in the browser. On a CBCT test patch this changed 0.002 % of the voxel labels.
- `model2d.onnx` is the same network rewritten with 2D convolutions over depth slices (it uses the
  same weights and gives the same result); browsers run it faster on the graphics card.
- The optimizer state and training logs of the checkpoint are not included.

The pre- and post-processing of nnU-Net (non-zero crop, resampling to 0.43 × 0.31 × 0.43 mm, CT
normalisation, sliding window with Gaussian weighting) is re-implemented in `src/ai/` of this app.
The conversion scripts are in `tools/dentalsegmentator/`.

Research software: check every segment before using it for treatment planning.
