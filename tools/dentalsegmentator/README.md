# DentalSegmentator → ONNX (for the browser)

Scripts that produced `public/models/dentalsegmentator/` from the original model
(Dot G, Zenodo 2024, doi:10.5281/zenodo.10829675, CC BY 4.0 – see that folder's README for credits).

```bash
python3 -m venv venv && venv/bin/pip install nnunetv2 onnx onnxruntime
# download and unzip Dataset112_DentalSegmentator_v100.zip from https://zenodo.org/records/10829675
M=Dataset112_DentalSegmentator_v100/nnUNetTrainer__nnUNetPlans__3d_fullres
venv/bin/python export_onnx.py $M out/ds_fp32.onnx           # PyTorch -> ONNX (fp32, embedded weights)
venv/bin/python pack_model.py out/ds_fp32.onnx web           # graph + fp16 weight chunks + manifest
# model2d.onnx: the checker needs the fp32 weights next to the graph
venv/bin/python -c "import numpy as np, glob; np.concatenate([np.fromfile(f, np.float16) for f in sorted(glob.glob('web/weights16.*.bin'))]).astype(np.float32).tofile('web/weights.bin')"
venv/bin/python make_2d_graph.py web/model.onnx web/model2d.onnx
rm web/weights.bin
venv/bin/python pack_model.py out/ds_fp32.onnx web           # again, to add model2d.onnx to the manifest
```

`load_ckpt.py` reads the checkpoint with `torch.load(weights_only=True)` (no pickled code runs).
