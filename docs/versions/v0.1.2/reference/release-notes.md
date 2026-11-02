# Release Notes: v0.1.2

Released May 1, 2026. [Full changelog on GitHub](https://github.com/spinningfactory/kloak/releases/tag/v0.1.2)

v0.1.2 adds IP-based host filtering, which moves the destination filters from labels to annotations, and captures the OpenSSL GCM key when the cipher is keyed.

## Highlights

### IP-based filtering, and filters move to annotations

`getkloak.io/hosts` now accepts an IPv4 or IPv6 address as well as a hostname. An address is matched against the connection's destination directly, without DNS. Since label values can't hold IPv6 addresses, `getkloak.io/hosts` and `getkloak.io/port` are now **annotations**, which also allows `PORT/udp` and `PORT/tcp` port values. ([#147](https://github.com/spinningfactory/kloak/pull/147))

See [Host Filtering](/guides/host-filtering).

### GCM key captured at cipher init

For OpenSSL, uprobes on libcrypto's `EVP_CipherInit_ex` capture the GCM hash key when the cipher is keyed and cache it. Kloak falls back to reading the key from OpenSSL's structures when the hook isn't available. The hook also works for OpenSSL statically linked into the executable, such as Node.js. ([#188](https://github.com/spinningfactory/kloak/pull/188), [#191](https://github.com/spinningfactory/kloak/pull/191))

## Fixes

- Guaranteed QoS pods on nodes with the `cgroupfs` driver (Talos, some kubeadm setups) are found, so their TLS uprobes are attached. Before, they sent placeholders unchanged. ([#185](https://github.com/spinningfactory/kloak/pull/185))
- The controller shuts down gracefully with bounded cleanup, and exits instead of hanging when the eBPF programs fail to load. ([#172](https://github.com/spinningfactory/kloak/pull/172), [#173](https://github.com/spinningfactory/kloak/pull/173), [#176](https://github.com/spinningfactory/kloak/pull/176))
- Built with Go 1.26.2. ([#158](https://github.com/spinningfactory/kloak/pull/158))

## Upgrade Notes

- **Move `getkloak.io/hosts` and `getkloak.io/port` from labels to annotations before upgrading.** This release ignores them as labels, without rejecting them, so a Secret that keeps them as labels is rewritten for any destination.
- The chart's demo still sets `getkloak.io/hosts` as a label, so both demo secrets are rewritten.

## Known Issues

These are fixed in v0.2.0. See [Supported Runtimes](/guides/supported-runtimes#known-issues).

- OpenSSL 3.0 and 3.1 are not rewritten.
- OpenSSL 3.1+ is not rewritten on x86 CPUs with AVX-512 and VAES.
- Rewrites inside HTTP/2 headers are usually invalid, and the server rejects the request.
- Only `secret` volumes are rewritten: a pod that reads a protected secret through an environment variable gets the real value.
- Patching happens inside the pod's network namespace, and needs Linux 6.6+ (TCX).

## Supported Versions

| Component | Versions |
|---|---|
| Linux kernel | 6.6+ |
| Kubernetes | 1.28+ |
| OpenSSL | 3.2 -- 3.5 (3.0 and 3.1 have offsets but a known issue) |
| Go `crypto/tls` | 1.25 -- 1.26 |

See [Supported Runtimes](/guides/supported-runtimes) and [Requirements](/reference/requirements).
