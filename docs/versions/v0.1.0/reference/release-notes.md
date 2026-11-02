# Release Notes: v0.1.0

Released April 20, 2026. [Full changelog on GitHub](https://github.com/spinningfactory/kloak/releases/tag/v0.1.0)

v0.1.0 is the first release of Kloak. Applications read random `kloak:` placeholders from their mounted secrets, and Kloak patches the real values into their encrypted TLS traffic in the kernel, after the TLS library has encrypted the placeholder.

## What's in the First Release

- **Shadow secrets.** A controller creates a `<name>-kloak` shadow for every Secret labeled `getkloak.io/enabled=true`, with a placeholder of the same length for each value, and checks that no two placeholders share the 8-byte lookup key. ([#106](https://github.com/spinningfactory/kloak/pull/106))
- **Pod rewriting.** A mutating webhook points kloak-enabled pods' `secret` volumes at the shadows. It only receives pods from kloak-enabled namespaces and pods, so other workloads are unaffected when it's down, and it rejects a pod whose shadow doesn't exist yet rather than mounting the real secret. ([#105](https://github.com/spinningfactory/kloak/pull/105))
- **In-kernel rewriting.** eBPF uprobes find placeholders in TLS writes, and a tc program XOR-patches the AES-GCM ciphertext and fixes the authentication tag. The real value never enters the pod's memory.
- **Host and port filtering** with the `getkloak.io/hosts` and `getkloak.io/port` labels. The destination host is verified through DNS answers from trusted resolvers.
- **Runtimes:** OpenSSL 3.0 -- 3.5, including OpenSSL statically linked into the executable such as Node.js, and Go `crypto/tls`. ([#138](https://github.com/spinningfactory/kloak/pull/138), [#141](https://github.com/spinningfactory/kloak/pull/141))
- **Packaging:** versioned images on GHCR (`ghcr.io/spinningfactory/kloak`) and a Helm chart at `https://chart.getkloak.io`, with an optional demo app (`demo.enabled`). ([#100](https://github.com/spinningfactory/kloak/pull/100), [#101](https://github.com/spinningfactory/kloak/pull/101), [#148](https://github.com/spinningfactory/kloak/pull/148))

## Notable Changes Before the Release

- Secrets are read from the controller's Kubernetes informer cache; there is no separate in-memory copy. ([#133](https://github.com/spinningfactory/kloak/pull/133))
- BPF maps that the programs only read are read-only for them. ([#108](https://github.com/spinningfactory/kloak/pull/108))
- BPF maps are sized for production clusters. ([#144](https://github.com/spinningfactory/kloak/pull/144))
- Secrets are synced into the BPF maps before the uprobes are attached, and TLS 1.3 nonce lengths are read from the connection. ([#149](https://github.com/spinningfactory/kloak/pull/149), [#140](https://github.com/spinningfactory/kloak/pull/140))

## Known Issues

These are fixed in later releases. See [Supported Runtimes](/guides/supported-runtimes#known-issues).

- Kloak-enabled Secrets are not validated at admission: short or long values, and invalid host or port labels, only show up at runtime (v0.1.1).
- Guaranteed QoS pods on nodes with the `cgroupfs` driver send placeholders unchanged (v0.1.2).
- OpenSSL 3.0 and 3.1 are not rewritten, nor OpenSSL 3.1+ on x86 CPUs with AVX-512 and VAES (v0.2.0).
- Rewrites inside HTTP/2 headers are usually invalid (v0.2.0).
- Only `secret` volumes are rewritten: a pod that reads a protected secret through an environment variable gets the real value (v0.2.0).
- Patching happens inside the pod's network namespace, and needs Linux 6.6+ (v0.2.0).

## Supported Versions

| Component | Versions |
|---|---|
| Linux kernel | 6.6+ |
| Kubernetes | 1.28+ |
| OpenSSL | 3.2 -- 3.5 (3.0 and 3.1 have offsets but a known issue) |
| Go `crypto/tls` | 1.25 -- 1.26 |

See [Supported Runtimes](/guides/supported-runtimes) and [Requirements](/reference/requirements).
