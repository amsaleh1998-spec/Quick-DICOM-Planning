"""Rewrite the 3D U-Net graph so every 3D op runs as 2D ops over depth slices.

Layout inside: [D, C, H, W] (depth as the batch). The input [1, 1, D, H, W] and the output
[1, 6, D, H, W] are unchanged, and the graph uses the same external weights file (the 5D
weights are sliced with constant-foldable Slice/Squeeze ops).

  Conv3d k3 (stride sd, sh, sw)  -> Σ_kd Conv2d(slice_kd(pad_D(x)), W[:, :, kd])
  ConvTranspose3d k(2, kh, kw)   -> ConvTranspose2d per depth tap, interleaved along D
  InstanceNorm3d                 -> ReduceMean over (D, H, W) per channel
"""
import sys
import numpy as np, onnx
from onnx import helper, numpy_helper, TensorProto

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src, load_external_data=False)
g = m.graph
D0, H0, W0 = [d.dim_value for d in g.input[0].type.tensor_type.shape.dim[2:]]
inits = {i.name: i for i in g.initializer}
nodes, consts = [], []
uid = [0]


def name(base):
    uid[0] += 1
    return f'{base}__{uid[0]}'


def const(arr, base='c'):
    n = name(base)
    consts.append(numpy_helper.from_array(np.asarray(arr), n))
    return n


def node(op, inputs, base, **attrs):
    out = name(base)
    nodes.append(helper.make_node(op, inputs, [out], name=out, **attrs))
    return out


def dims_of(init_name):
    return list(inits[init_name].dims)


def tap(w, k, axis=2):
    """W[:, :, k] (5D weight) as a 4D weight."""
    s = node('Slice', [w, const([k], 'st'), const([k + 1], 'en'), const([axis], 'ax')], 'wslice')
    return node('Squeeze', [s, const([axis], 'ax')], 'wsq')


depth = {}
x = node('Reshape', ['input', const([D0, 1, H0, W0], 'shape')], 'in2d')  # [1,1,D,H,W] -> [D,1,H,W]
depth[x] = (D0, H0, W0)
rename = {'input': x}

for n in g.node:
    ins = [rename.get(i, i) for i in n.input]
    a = {at.name: helper.get_attribute_value(at) for at in n.attribute}
    out_name = n.output[0]
    if n.op_type == 'Conv':
        X, W = ins[0], ins[1]
        B = ins[2] if len(ins) > 2 else None
        D, H, Wd = depth[X]
        k = a['kernel_shape']
        sd, sh, sw = a['strides']
        Hout = (H + 2 * a['pads'][1] - k[1]) // sh + 1
        Wout = (Wd + 2 * a['pads'][2] - k[2]) // sw + 1
        if k == [1, 1, 1]:
            y = node('Conv', [X, tap(W, 0)] + ([B] if B else []), 'conv1x1', kernel_shape=[1, 1], strides=[1, 1], pads=[0, 0, 0, 0])
            Dout = D
        else:
            assert k[0] == 3 and a['pads'][0] == 1, (k, a['pads'])
            Dout = (D + 2 - 3) // sd + 1
            xp = node('Pad', [X, const(np.array([1, 0, 0, 0, 1, 0, 0, 0], np.int64), 'pads')], 'padD', mode='constant')
            terms = []
            for kd in range(3):
                xs = node('Slice', [xp, const([kd], 'st'), const([kd + sd * (Dout - 1) + 1], 'en'), const([0], 'ax'), const([sd], 'sp')], 'sliceD')
                ph, pw = a['pads'][1], a['pads'][2]
                inp = [xs, tap(W, kd)] + ([B] if (B and kd == 1) else [])
                terms.append(node('Conv', inp, f'conv2d_k{kd}', kernel_shape=k[1:], strides=[sh, sw], pads=[ph, pw, ph, pw]))
            y = node('Add', [node('Add', [terms[0], terms[1]], 'sum'), terms[2]], 'sum')
        depth[y] = (Dout, Hout, Wout)
    elif n.op_type == 'InstanceNormalization':
        X, gamma, beta = ins
        C = dims_of(gamma)[0]
        mean = node('ReduceMean', [X], 'mean', axes=[0, 2, 3], keepdims=1)
        xc = node('Sub', [X, mean], 'xc')
        var = node('ReduceMean', [node('Mul', [xc, xc], 'sq')], 'var', axes=[0, 2, 3], keepdims=1)
        std = node('Sqrt', [node('Add', [var, const(np.array([a['epsilon']], np.float32), 'eps')], 'vareps')], 'std')
        g4 = node('Reshape', [gamma, const([1, C, 1, 1], 'shape')], 'gamma4')
        b4 = node('Reshape', [beta, const([1, C, 1, 1], 'shape')], 'beta4')
        scale = node('Div', [g4, std], 'scale')
        y = node('Add', [node('Mul', [xc, scale], 'xs'), b4], 'norm')
        depth[y] = depth[X]
    elif n.op_type == 'LeakyRelu':
        y = node('LeakyRelu', [ins[0]], 'lrelu', alpha=a['alpha'])
        depth[y] = depth[ins[0]]
    elif n.op_type == 'ConvTranspose':
        X, W, B = ins
        D, H, Wd = depth[X]
        k = a['kernel_shape']
        Cout = dims_of(W)[1]
        Hout, Wout = H * k[1], Wd * k[2]
        assert a['strides'] == k and a['pads'] == [0] * 6, a
        if k[0] == 1:
            y = node('ConvTranspose', [X, tap(W, 0), B], 'convT', kernel_shape=k[1:], strides=k[1:])
            Dout = D
        else:
            assert k[0] == 2
            ys = [node('Unsqueeze', [node('ConvTranspose', [X, tap(W, t), B], f'convT{t}', kernel_shape=k[1:], strides=k[1:]), const([1], 'ax')], 'unsq') for t in range(2)]
            cat = node('Concat', ys, 'interleave', axis=1)  # [D, 2, C, H, W]
            y = node('Reshape', [cat, const([2 * D, Cout, Hout, Wout], 'shape')], 'convT_out')
            Dout = 2 * D
        depth[y] = (Dout, Hout, Wout)
    elif n.op_type == 'Concat':
        assert a['axis'] == 1
        y = node('Concat', ins, 'cat', axis=1)
        depth[y] = depth[ins[0]]
        assert depth[ins[0]] == depth[ins[1]]
    else:
        raise SystemExit(f'unsupported op {n.op_type}')
    rename[out_name] = y

final = rename[g.output[0].name]  # [D, 6, H, W]
t = node('Transpose', [final], 'toCDHW', perm=[1, 0, 2, 3])
nodes.append(helper.make_node('Unsqueeze', [t, const([0], 'ax')], ['logits'], name='logits'))

new = helper.make_graph(nodes, g.name + '_2d', list(g.input), list(g.output), list(g.initializer) + consts)
mm = helper.make_model(new, opset_imports=m.opset_import, producer_name=m.producer_name + ' (2D decomposition)')
mm.ir_version = m.ir_version
onnx.save(mm, dst)
onnx.checker.check_model(dst)
onnx.save(mm, dst)
print('nodes', len(mm.graph.node), '->', dst)
