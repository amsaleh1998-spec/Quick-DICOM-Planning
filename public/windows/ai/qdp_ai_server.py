"""QDP AI service - the full DentalSegmentator model for Quick DICOM Planning.

Runs the official nnU-Net v2 prediction of DentalSegmentator (full-precision weights, mirrored
passes, Gaussian sliding window - the same as the model's 3D Slicer extension) on this computer,
on an NVIDIA graphics card when there is one. The Quick DICOM Planning web app sends it the scan
region over a local connection (127.0.0.1 only - the scan never leaves the computer) and gets the
labels back.

    python qdp_ai_server.py [--model DIR] [--port 47423] [--cpu]

Endpoints (JSON unless noted; requests from other web sites are refused):
    GET    /status              service, version, model, device
    POST   /segment             body: int16 little endian voxels in SimpleITK order (z, y, x);
                                headers X-QDP-Dims: "nz,ny,nx", X-QDP-Spacing: "sz,sy,sx" (mm),
                                optional X-QDP-Mirroring: 0 -> {"job": id}
    GET    /jobs/<id>           state, phase, done, total, message
    GET    /jobs/<id>/result    binary: class per voxel (uint8), then the margin per voxel (uint8:
                                (best - second best logit) x 16, 1..255; 255 outside the scan)
    DELETE /jobs/<id>           cancel
    POST   /quit                stop the service

Model: Dot G, et al. DentalSegmentator. Journal of Dentistry (2024), doi:10.1016/j.jdent.2024.105130;
weights Dot G, Zenodo (2024), doi:10.5281/zenodo.10829675 (CC BY 4.0). nnU-Net: Isensee F, et al.
Nat Methods 2021;18:203-211. Research software - check every segment.
"""
import argparse
import json
import logging
import os
import re
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '1.2.0'
DEFAULT_PORT = 47423
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, 'model', 'Dataset112_DentalSegmentator_v100', 'nnUNetTrainer__nnUNetPlans__3d_fullres')
# web pages allowed to use the service: the app, and a local copy of it (development, tests)
ALLOWED_ORIGINS = [re.compile(r'^https://quickdicom\.app$'), re.compile(r'^http://(localhost|127\.0\.0\.1)(:\d+)?$')]
MAX_VOXELS = 400_000_000
JOB_KEEP_S = 600

log = logging.getLogger('qdp-ai')


class Cancelled(Exception):
    pass


def gpu_check():
    """Run a small 3D network on the CUDA card (the layers nnU-Net uses): None when it works, else
    why not - e.g. a PyTorch build without kernels for this card's generation."""
    import torch
    try:
        d = torch.device('cuda')
        F = torch.nn.functional
        x = torch.randn(1, 1, 24, 24, 24, device=d)
        y = F.leaky_relu(F.instance_norm(F.conv3d(x, torch.randn(4, 1, 3, 3, 3, device=d), padding=1)))
        y = F.conv_transpose3d(y, torch.randn(4, 2, 2, 2, 2, device=d), stride=2)
        with torch.autocast('cuda'):
            z = F.conv3d(x, torch.randn(4, 1, 3, 3, 3, device=d), padding=1)
        float(y.sum()) + float(z.float().sum())
        torch.cuda.synchronize()
        return None
    except Exception as e:  # noqa: BLE001
        return f'{type(e).__name__}: ' + ((str(e).splitlines() or [''])[0])[:300]


def is_cuda_error(e):
    t = f'{type(e).__name__}: {e}'
    return 'CUDA' in t or 'cuDNN' in t or 'AcceleratorError' in t


class Job:
    def __init__(self, data, spacing, mirroring):
        self.id = uuid.uuid4().hex
        self.data = data
        self.spacing = spacing
        self.mirroring = mirroring
        self.state = 'queued'  # queued, running, done, error, cancelled
        self.phase = 'Waiting…'
        self.done = 0
        self.total = 0
        self.message = ''
        self.result = None
        self.cancel = False
        self.created = time.time()
        self.finished = None

    def info(self):
        return {'id': self.id, 'state': self.state, 'phase': self.phase, 'done': self.done, 'total': self.total,
                'message': self.message, 'seconds': round((self.finished or time.time()) - self.created, 1)}


class Service:
    def __init__(self, model_dir, force_cpu=False):
        self.model_dir = model_dir
        self.force_cpu = force_cpu
        self.jobs = {}
        self.queue = []
        self.lock = threading.Condition()
        self.predictor = None
        self.device_name = None
        self.gpu = None
        self.gpu_error = None
        self.load_error = None
        self.device_lock = threading.Lock()
        threading.Thread(target=self.worker, daemon=True).start()
        # PyTorch and the card check take a while on a fresh start (e.g. at login): in the background,
        # so the service answers at once ('starting')
        threading.Thread(target=self.device, daemon=True).start()

    # ---- device -----------------------------------------------------------------------------
    def device(self):
        with self.device_lock:
            return self._device()

    def _device(self):
        if self.device_name is None:
            import torch
            dev = 'cpu'
            if not self.force_cpu and torch.cuda.is_available():
                self.gpu = torch.cuda.get_device_name(0)
                err = gpu_check()
                if err is None:
                    dev = 'cuda'
                else:
                    # e.g. a PyTorch build without kernels for this card: the CPU (slow) rather than nothing
                    self.gpu_error = err
                    log.warning('the graphics card %s cannot run the model (%s) - using the CPU', self.gpu, err)
            self.device_name = dev  # (only now: until then the status says 'starting')
            log.info('device: %s%s', dev, f' ({self.gpu})' if self.gpu else '')
        return self.device_name

    def fall_back_to_cpu(self, err):
        log.warning('CUDA failed during a run (%s) - continuing on the CPU', err)
        self.gpu_error = err
        self.device_name = 'cpu'
        self.predictor = None

    def status(self):
        # not waiting for PyTorch here: while it loads, the app is told the service is starting
        dev = self.device_name or 'starting'
        folds = sorted(d for d in os.listdir(self.model_dir) if d.startswith('fold_')) if os.path.isdir(self.model_dir) else []
        return {
            'service': 'qdp-ai', 'version': VERSION,
            'model': 'DentalSegmentator 1.0.0 (nnU-Net v2, 3d_fullres, ' + (', '.join(folds) or 'no model found') + ')',
            'modelFound': bool(folds),
            'device': dev, 'gpu': self.gpu, 'gpuError': self.gpu_error, 'torch': self.torch_version(), 'busy': any(j.state in ('queued', 'running') for j in self.jobs.values()),
            'loadError': self.load_error,
        }

    def torch_version(self):
        t = sys.modules.get('torch')
        return getattr(t, '__version__', None) if t else None

    # ---- the model --------------------------------------------------------------------------
    def get_predictor(self):
        if self.predictor is None:
            import torch
            from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
            dev = torch.device(self.device())
            if dev.type == 'cpu':
                torch.set_num_threads(max(1, os.cpu_count() or 1))
            p = nnUNetPredictor(tile_step_size=0.5, use_gaussian=True, use_mirroring=True,
                                perform_everything_on_device=dev.type == 'cuda', device=dev,
                                verbose=False, verbose_preprocessing=False, allow_tqdm=False)
            # every fold that is there (the published model has fold 0)
            p.initialize_from_trained_model_folder(self.model_dir, use_folds=None, checkpoint_name='checkpoint_final.pth')
            self.predictor = p
            log.info('model loaded from %s on %s', self.model_dir, dev)
        return self.predictor

    def predict(self, job):
        import numpy as np
        p = self.get_predictor()
        p.use_mirroring = job.mirroring
        # progress and cancelling: count the network evaluations of the sliding window
        orig_slicers = type(p)._internal_get_sliding_window_slicers
        orig_predict = type(p)._internal_maybe_mirror_and_predict

        def slicers(image_size):
            s = orig_slicers(p, image_size)
            job.total = len(s)
            job.done = 0
            job.phase = 'Segmenting…'
            return s

        def predict_tile(x):
            if job.cancel:
                raise Cancelled()
            r = orig_predict(p, x)
            job.done += 1
            return r

        p._internal_get_sliding_window_slicers = slicers
        p._internal_maybe_mirror_and_predict = predict_tile
        try:
            job.phase = 'Preparing the scan…'
            img = job.data.astype(np.float32)[None]
            seg, probs = p.predict_single_npy_array(img, {'spacing': list(job.spacing)}, None, None, True)
        finally:
            del p._internal_get_sliding_window_slicers
            del p._internal_maybe_mirror_and_predict
        if job.cancel:
            raise Cancelled()
        job.phase = 'Finishing…'
        cls = np.ascontiguousarray(seg, dtype=np.uint8)
        margin = np.empty(cls.shape, dtype=np.uint8)
        # margin between the best and the second class: log(p1 / p2) = the logit difference
        for z0 in range(0, cls.shape[0], 8):
            pr = np.asarray(probs[:, z0:z0 + 8], dtype=np.float32)
            top = np.partition(pr, -2, axis=0)
            best, second = top[-1], top[-2]
            m = np.log(np.maximum(best, 1e-30)) - np.log(np.maximum(second, 1e-30))
            mm = np.clip(np.round(m * 16), 1, 255)
            mm[best <= 0] = 255  # outside the scan's non-zero region: plain background
            margin[z0:z0 + 8] = mm.astype(np.uint8)
        return cls.tobytes() + margin.tobytes()

    # ---- jobs -------------------------------------------------------------------------------
    def submit(self, data, spacing, mirroring):
        job = Job(data, spacing, mirroring)
        with self.lock:
            self.cleanup()
            self.jobs[job.id] = job
            self.queue.append(job)
            self.lock.notify()
        return job

    def cleanup(self):
        now = time.time()
        for k in [k for k, j in self.jobs.items() if j.finished and now - j.finished > JOB_KEEP_S]:
            del self.jobs[k]

    def worker(self):
        while True:
            with self.lock:
                while not self.queue:
                    self.lock.wait()
                job = self.queue.pop(0)
            if job.cancel:
                job.state, job.finished = 'cancelled', time.time()
                continue
            job.state = 'running'
            t0 = time.time()
            try:
                job.phase = 'Loading the model…' if self.predictor is None else 'Preparing the scan…'
                try:
                    job.result = self.predict(job)
                except Exception as e:  # noqa: BLE001
                    if self.device_name != 'cuda' or not is_cuda_error(e) or job.cancel:
                        raise
                    # the card failed (e.g. no kernels for it in this PyTorch): the same run on the CPU
                    self.fall_back_to_cpu(f'{type(e).__name__}: ' + ((str(e).splitlines() or [''])[0])[:300])
                    job.phase = 'The graphics card failed – on the CPU (slow)…'
                    job.done = 0
                    job.result = self.predict(job)
                job.state = 'done'
                log.info('job %s: %s voxels in %.1f s (%d tiles, mirroring %s)', job.id, job.data.size, time.time() - t0, job.total, job.mirroring)
            except Cancelled:
                job.state = 'cancelled'
                log.info('job %s cancelled', job.id)
            except Exception as e:  # noqa: BLE001 - reported to the app
                job.state = 'error'
                job.message = f'{type(e).__name__}: {e}'
                self.load_error = job.message if self.predictor is None else None
                log.error('job %s failed\n%s', job.id, traceback.format_exc())
            finally:
                job.data = None
                job.finished = time.time()


def make_handler(service, server_ref):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'QDP-AI/' + VERSION
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *args):  # quieter than the default
            log.debug('%s - %s', self.address_string(), fmt % args)

        # ---- CORS: only the app's own pages may use the service ----------------------------
        def origin_ok(self):
            o = self.headers.get('Origin')
            return o is None or any(r.match(o) for r in ALLOWED_ORIGINS)

        def cors(self):
            o = self.headers.get('Origin')
            if o and any(r.match(o) for r in ALLOWED_ORIGINS):
                self.send_header('Access-Control-Allow-Origin', o)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Expose-Headers', 'X-QDP-Dims')

        def reply(self, code, body=b'', ctype='application/json', extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.cors()
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_OPTIONS(self):
            if not self.origin_ok():
                return self.reply(403, {'error': 'origin not allowed'})
            self.send_response(204)
            self.cors()
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-QDP-Dims, X-QDP-Spacing, X-QDP-Mirroring')
            self.send_header('Access-Control-Max-Age', '600')
            # Chrome / Edge: a public web page reaching this computer's own service
            if self.headers.get('Access-Control-Request-Private-Network') == 'true':
                self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def job(self):
            m = re.match(r'^/jobs/([0-9a-f]{32})(/result)?$', self.path)
            if not m:
                return None, False
            return service.jobs.get(m.group(1)), bool(m.group(2))

        def do_GET(self):
            if not self.origin_ok():
                return self.reply(403, {'error': 'origin not allowed'})
            if self.path == '/status':
                return self.reply(200, service.status())
            job, result = self.job()
            if job is None:
                return self.reply(404, {'error': 'not found'})
            if not result:
                return self.reply(200, job.info())
            if job.state != 'done' or job.result is None:
                return self.reply(409, {'error': 'no result', 'state': job.state})
            body, job.result = job.result, None  # handed over once
            return self.reply(200, body, 'application/octet-stream')

        def do_DELETE(self):
            if not self.origin_ok():
                return self.reply(403, {'error': 'origin not allowed'})
            job, _ = self.job()
            if job is None:
                return self.reply(404, {'error': 'not found'})
            job.cancel = True
            return self.reply(200, job.info())

        def do_POST(self):
            if not self.origin_ok():
                return self.reply(403, {'error': 'origin not allowed'})
            if self.path == '/quit':
                self.reply(200, {'ok': True})
                threading.Thread(target=server_ref[0].shutdown, daemon=True).start()
                return
            if self.path != '/segment':
                return self.reply(404, {'error': 'not found'})
            import numpy as np
            try:
                dims = [int(v) for v in self.headers.get('X-QDP-Dims', '').split(',')]
                spacing = [float(v) for v in self.headers.get('X-QDP-Spacing', '').split(',')]
                mirroring = self.headers.get('X-QDP-Mirroring', '1') != '0'
                n = int(self.headers.get('Content-Length', '0'))
                if len(dims) != 3 or len(spacing) != 3 or min(dims) < 1 or min(spacing) <= 0:
                    raise ValueError('X-QDP-Dims / X-QDP-Spacing missing or invalid')
                count = dims[0] * dims[1] * dims[2]
                if count > MAX_VOXELS:
                    raise ValueError('the region is too large')
                if n != 2 * count:
                    raise ValueError(f'expected {2 * count} bytes, got {n}')
            except ValueError as e:
                return self.reply(400, {'error': str(e)})
            buf = bytearray(n)
            view = memoryview(buf)
            got = 0
            while got < n:
                r = self.rfile.readinto(view[got:])
                if not r:
                    return self.reply(400, {'error': 'body incomplete'})
                got += r
            data = np.frombuffer(bytes(buf), dtype='<i2').reshape(dims)
            job = service.submit(data, spacing, mirroring)
            log.info('job %s: %s voxels, spacing %s', job.id, dims, spacing)
            return self.reply(200, {'job': job.id})

    return Handler


def main():
    ap = argparse.ArgumentParser(description='QDP AI service (DentalSegmentator, nnU-Net v2)')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--port', type=int, default=DEFAULT_PORT)
    ap.add_argument('--cpu', action='store_true', help='do not use the graphics card')
    ap.add_argument('--log', default=os.path.join(HERE, 'log.txt'))
    a = ap.parse_args()
    handlers = [logging.StreamHandler(sys.stderr)] if sys.stderr else []
    try:
        handlers.append(logging.FileHandler(a.log, encoding='utf-8'))
    except OSError:
        pass
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', handlers=handlers)
    service = Service(a.model, a.cpu)
    ref = [None]
    try:
        server = ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(service, ref))
    except OSError as e:
        log.error('port %s is in use - is the service running already? (%s)', a.port, e)
        sys.exit(1)
    ref[0] = server
    log.info('QDP AI service %s on http://127.0.0.1:%s (model %s)', VERSION, a.port, a.model)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    log.info('stopped')


if __name__ == '__main__':
    main()
