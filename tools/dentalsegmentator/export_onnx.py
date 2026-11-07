"""Rebuild the DentalSegmentator network from its plans, load the weights, export ONNX (fp32)."""
import sys, json, time
import torch
from torch import nn
from dynamic_network_architectures.architectures.unet import PlainConvUNet
from load_ckpt import load

model_dir, out_path = sys.argv[1], sys.argv[2]
plans = json.load(open(f'{model_dir}/plans.json'))
ds = json.load(open(f'{model_dir}/dataset.json'))
c = plans['configurations']['3d_fullres']
n_stages = len(c['conv_kernel_sizes'])
feats = [min(c['UNet_base_num_features'] * 2 ** i, c['unet_max_num_features']) for i in range(n_stages)]
num_classes = len(ds['labels'])
print('features', feats, 'classes', num_classes)

net = PlainConvUNet(
    input_channels=1, n_stages=n_stages, features_per_stage=feats, conv_op=nn.Conv3d,
    kernel_sizes=c['conv_kernel_sizes'], strides=c['pool_op_kernel_sizes'],
    n_conv_per_stage=c['n_conv_per_stage_encoder'], num_classes=num_classes,
    n_conv_per_stage_decoder=c['n_conv_per_stage_decoder'], conv_bias=True,
    norm_op=nn.InstanceNorm3d, norm_op_kwargs={'eps': 1e-5, 'affine': True},
    dropout_op=None, nonlin=nn.LeakyReLU, nonlin_kwargs={'inplace': True}, deep_supervision=False)
ck = load(f'{model_dir}/fold_0/checkpoint_final.pth')
missing, unexpected = net.load_state_dict(ck['network_weights'], strict=False)
print('missing', missing, 'unexpected', unexpected)
net.eval()
n = sum(p.numel() for p in net.parameters())
print(f'params {n} ({n * 4 / 1e6:.1f} MB fp32)')

ps = c['patch_size']
x = torch.randn(1, 1, *ps)
t = time.time()
with torch.no_grad():
    y = net(x)
print('torch forward', tuple(y.shape), f'{time.time() - t:.1f}s')
torch.onnx.export(net, x, out_path, input_names=['input'], output_names=['logits'], opset_version=17,
                  dynamo=False, do_constant_folding=True)
print('exported', out_path)
torch.save({'x': x, 'y': y}, out_path + '.ref.pt')
