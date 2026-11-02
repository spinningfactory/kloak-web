# Release Notes: v0.2.0

Released October 9, 2026. [Full changelog on GitHub](https://github.com/spinningfactory/kloak/releases/tag/v0.2.0)

v0.2.0 is a large release. It hardens where and for whom secrets are rewritten, makes HTTP/2 rewrites valid, makes kernels before 6.6 work, and adds BoringSSL, Bun, and older Go versions.

## Highlights

### Per-pod secret binding

A pod can only use the secrets its spec references (a `secret` volume, `secretKeyRef`, or `envFrom`). A placeholder sent by any other kloak-enabled pod, even one that learned it, goes out unchanged, and the controller logs a `secret binding violation`. Set `controller.ebpf.secretBinding: audit` to log violations without refusing them. ([#320](https://github.com/spinningfactory/kloak/pull/320))

See [Per-Pod Secret Binding](/getting-started/configuration#per-pod-secret-binding).

### Patching outside the pod

The tc program now patches the ciphertext at ingress on the host side of the pod's veth, so in-pod packet capture never sees the patched records. Loopback traffic is no longer patched. The egress interface is detected from the pod's default route (`controller.ebpf.egressInterface`). ([#287](https://github.com/spinningfactory/kloak/pull/287), [#235](https://github.com/spinningfactory/kloak/pull/235))

### Kernels before 6.6

On kernels without TCX, the tc program attaches through a `clsact` qdisc and a `cls_bpf` filter, so Linux 5.17 -- 6.5 can rewrite secrets too. Before, the attach failed on those kernels and nothing was rewritten. Set `controller.ebpf.tcAttachMode` to force either mode. ([#316](https://github.com/spinningfactory/kloak/pull/316))

### New placeholders, valid HTTP/2 rewrites

Placeholders are now `kl::` followed by random characters, with exactly the same byte length and HPACK Huffman bit length as the real value. Rewrites inside HTTP/2 headers no longer end with invalid padding, which strict decoders such as nghttp2 and AWS ALB rejected. The validating webhook rejects the rare values no same-length placeholder can match. ([#233](https://github.com/spinningfactory/kloak/pull/233), [#272](https://github.com/spinningfactory/kloak/pull/272))

### Environment variables are protected

The webhook now rewrites `env[].valueFrom.secretKeyRef` and `envFrom[].secretRef` references to kloak-enabled secrets, as well as `secret` volumes. Before, a pod that read a protected secret through an environment variable got the real value. ([#218](https://github.com/spinningfactory/kloak/pull/218))

### More runtimes

- **BoringSSL**, statically linked or as a shared library, with the GCM key recomputed in the kernel. ([#261](https://github.com/spinningfactory/kloak/pull/261))
- **Bun** single-executable builds, 1.3.12 -- 1.4.2, including 1.4.1+, which sends the first request together with the end of the handshake. ([#264](https://github.com/spinningfactory/kloak/pull/264), [#317](https://github.com/spinningfactory/kloak/pull/317))
- **Go 1.20 -- 1.27**. ([#198](https://github.com/spinningfactory/kloak/pull/198), [#208](https://github.com/spinningfactory/kloak/pull/208), [#209](https://github.com/spinningfactory/kloak/pull/209), [#290](https://github.com/spinningfactory/kloak/pull/290))
- **OpenSSL 3.6**, and offsets tracked for 4.0. ([#255](https://github.com/spinningfactory/kloak/pull/255))
- Nightly jobs now discover offsets and run the end-to-end tests against every tracked OpenSSL, Go, BoringSSL, and Bun release. ([#201](https://github.com/spinningfactory/kloak/pull/201), [#244](https://github.com/spinningfactory/kloak/pull/244), [#245](https://github.com/spinningfactory/kloak/pull/245))

## Fixes

- OpenSSL 3.0 and 3.1 are rewritten again: a struct offset that was only correct for 3.2+ made Kloak skip them. ([#222](https://github.com/spinningfactory/kloak/pull/222))
- OpenSSL 3.1+ is rewritten on x86 CPUs with AVX-512 and VAES, where the GCM key is stored in a different place. ([#313](https://github.com/spinningfactory/kloak/pull/313), see [Chasing a Flake Into OpenSSL's GCM Path](https://getkloak.io/blog/the-h-that-wasnt-there/))
- A secret with `getkloak.io/hosts` or `getkloak.io/port` set as a label is rejected by the validating webhook, and skipped by the controller, instead of being rewritten for any destination. ([#314](https://github.com/spinningfactory/kloak/pull/314))
- The chart's demo sets `getkloak.io/hosts` as an annotation. ([#315](https://github.com/spinningfactory/kloak/pull/315))
- Robustness fixes in the eBPF data plane: a cold-start race when recovering the OpenSSL GCM key, tc attach races, and shutdown. ([#262](https://github.com/spinningfactory/kloak/pull/262), [#237](https://github.com/spinningfactory/kloak/pull/237), [#238](https://github.com/spinningfactory/kloak/pull/238), [#239](https://github.com/spinningfactory/kloak/pull/239), [#240](https://github.com/spinningfactory/kloak/pull/240), [#241](https://github.com/spinningfactory/kloak/pull/241))

## Upgrade Notes

- **Restart kloak-enabled pods after upgrading.** The controller regenerates every `kloak:` placeholder as a `kl::` placeholder, and pods that read the old one send it unchanged.
- **Move `getkloak.io/hosts` and `getkloak.io/port` to annotations** if any Secret still sets them as labels. Such Secrets are now rejected on update and skipped by the controller.
- **Check for pods that use secrets they don't reference**, for example apps that read a shadow secret through the Kubernetes API. They are refused by default; install with `controller.ebpf.secretBinding: audit` to find them first.
- New chart values: `controller.ebpf.egressInterface`, `controller.ebpf.tcAttachMode`, `controller.ebpf.secretBinding`, and `log.ebpfLevel`. ([#196](https://github.com/spinningfactory/kloak/pull/196))
- New `kloak version` subcommand. ([#205](https://github.com/spinningfactory/kloak/pull/205))

## Supported Versions

| Component | Versions |
|---|---|
| Linux kernel | 5.17+ (6.6+ for TCX) |
| Kubernetes | 1.28+ |
| OpenSSL | 3.0 -- 3.6 (4.0 offsets tracked) |
| Go `crypto/tls` | 1.20 -- 1.27 |
| BoringSSL | Recent releases (one set of offsets) |
| Bun | 1.3.12 -- 1.4.2 |

See [Supported Runtimes](/guides/supported-runtimes) and [Requirements](/reference/requirements).
