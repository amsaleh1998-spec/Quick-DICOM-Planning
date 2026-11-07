"""Load an nnU-Net checkpoint without executing pickled code (weights_only=True).

The DentalSegmentator checkpoint only needs numpy scalars / dtypes besides plain tensors.
"""
import numpy as np
import torch


def load(path):
    try:
        from numpy._core.multiarray import scalar
    except ImportError:
        from numpy.core.multiarray import scalar
    import numpy.dtypes as nd
    allow = [(scalar, 'numpy.core.multiarray.scalar'), np.dtype] + [getattr(nd, n) for n in dir(nd) if n.endswith('DType')]
    with torch.serialization.safe_globals(allow):
        return torch.load(path, map_location='cpu', weights_only=True)
