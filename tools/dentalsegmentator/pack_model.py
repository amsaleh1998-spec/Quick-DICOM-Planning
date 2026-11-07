"""Split the fp32 ONNX into a small graph (external data) + fp16 weight chunks for the web.

The graph references one external file, WEIGHTS (fp32). The browser downloads the fp16 chunks,
joins them and widens them to fp32: every initializer is float, so fp32 offset = 2 × fp16 offset.
"""
import sys, os, json, hashlib
import numpy as np, onnx
from onnx import numpy_helper, TensorProto

src, out_dir = sys.argv[1], sys.argv[2]
CHUNK = 16 * 1024 * 1024
WEIGHTS = 'weights.bin'
os.makedirs(out_dir, exist_ok=True)
m = onnx.load(src)
blob = bytearray()
for init in m.graph.initializer:
    assert init.data_type == TensorProto.FLOAT, (init.name, init.data_type)
    a = numpy_helper.to_array(init).astype(np.float32)
    h = a.astype(np.float16)
    assert np.isfinite(h).all(), init.name
    # 8-byte alignment in fp16 = 16-byte alignment in fp32
    while len(blob) % 8:
        blob += b'\0'
    off16 = len(blob)
    blob += h.tobytes()
    init.ClearField('raw_data')
    del init.float_data[:]
    init.data_location = TensorProto.EXTERNAL
    del init.external_data[:]
    for k, v in (('location', WEIGHTS), ('offset', str(off16 * 2)), ('length', str(a.size * 4))):
        e = init.external_data.add()
        e.key, e.value = k, v
m.producer_name = 'DentalSegmentator (Dot et al. 2024) – nnU-Net v2 3d_fullres fold 0, exported for the web'
graph = m.SerializeToString()
open(f'{out_dir}/model.onnx', 'wb').write(graph)
chunks = []
for i in range(0, len(blob), CHUNK):
    name = f'weights16.{len(chunks):02d}.bin'
    part = bytes(blob[i:i + CHUNK])
    open(f'{out_dir}/{name}', 'wb').write(part)
    chunks.append({'file': name, 'bytes': len(part), 'sha256': hashlib.sha256(part).hexdigest()})
manifest = {
    'name': 'DentalSegmentator',
    'version': '1.0.0',
    'graph': {'file': 'model.onnx', 'bytes': len(graph), 'sha256': hashlib.sha256(graph).hexdigest()},
    'weights': {'externalPath': WEIGHTS, 'fp16Bytes': len(blob), 'chunks': chunks},
}
if os.path.exists(f'{out_dir}/model2d.onnx'):
    b = open(f'{out_dir}/model2d.onnx', 'rb').read()
    manifest['graph2d'] = {'file': 'model2d.onnx', 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
manifest['source'] = {'title': 'DentalSegmentator nnU-Net pretrained model for CBCT image segmentation', 'doi': '10.5281/zenodo.10829675',
                      'file': 'Dataset112_DentalSegmentator_v100.zip', 'fold': 0, 'checkpoint': 'checkpoint_final.pth', 'license': 'CC-BY-4.0'}
manifest['changes'] = ('Converted from PyTorch to ONNX (opset 17), weights stored as float16; model2d.onnx runs the same network '
                       'as 2D convolutions over depth slices (same weights).')
json.dump(manifest, open(f'{out_dir}/manifest.json', 'w'), indent=1)
print('graph', len(graph), 'bytes; weights fp16', len(blob), 'bytes in', len(chunks), 'chunks')
