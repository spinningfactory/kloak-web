# Release Notes: v0.3.0

Released November 1, 2026. [Full changelog on GitHub](https://github.com/spinningfactory/kloak/releases/tag/v0.3.0)

v0.3.0 changes how Kloak decides which host a connection is for. Host-restricted secrets now rely on virtual IPs and an SNI check instead of reading the DNS answers on the node, which closes gaps with CDNs and shared addresses and adds IPv6. With NRI, a pod is fully prepared before its containers start.

## Highlights

### Virtual IPs for host-restricted secrets

Every hostname in a `getkloak.io/hosts` annotation gets its own virtual IP, from `198.18.0.0/15` and `2001:2::/48` by default. A pod that references a secret restricted to that host gets the virtual IP in its DNS answers, and its connections to it are redirected to the host's real addresses. The secret is only rewritten on a connection made through the virtual IP, so Kloak knows which host a connection is for even when hosts share addresses, as behind a CDN or a shared ingress. This replaces the node-wide DNS snooping of earlier releases. ([#331](https://github.com/spinningfactory/kloak/pull/331), [#333](https://github.com/spinningfactory/kloak/pull/333), [#335](https://github.com/spinningfactory/kloak/pull/335), [#338](https://github.com/spinningfactory/kloak/pull/338), [#344](https://github.com/spinningfactory/kloak/pull/344), [#346](https://github.com/spinningfactory/kloak/pull/346))

- The ranges are set with `controller.ebpf.virtualIPRange`. The controller refuses to start if they overlap a node address, pod CIDR, service CIDR, or node route.
- Only DNS answers from trusted resolvers are rewritten: kube-dns's ClusterIPs and endpoint addresses, kept current, plus `controller.dns.trustedServers`.
- The virtual IPs are pinned under `/sys/fs/bpf/kloak`, so a controller restart keeps them.

See [How Host Resolution Works](/guides/host-filtering#how-host-resolution-works).

### SNI check

A secret restricted to a hostname is only rewritten on a connection whose TLS ClientHello names that host. Connections without SNI, or with an encrypted ClientHello, are refused. Set `controller.ebpf.sniCheck: audit` to log mismatches instead of refusing them. ([#329](https://github.com/spinningfactory/kloak/pull/329))

### IPv6

AAAA answers get the host's virtual IPv6, IPv6 connects are redirected, and TLS records sent over IPv6 are patched. IPv6-only pods are supported. ([#339](https://github.com/spinningfactory/kloak/pull/339), [#361](https://github.com/spinningfactory/kloak/pull/361))

### Pods prepared before their containers start (NRI)

With containerd 2.0+ or CRI-O 1.30+, the container runtime waits for Kloak while it creates each pod sandbox and before each container starts. The DNS rewrite is in place before the first lookup, and the TLS uprobes before the first TLS write. Without NRI, Kloak now also attaches to pending pods and init containers. Configure it with `controller.nri.enabled` and `controller.nri.socketPath`. ([#340](https://github.com/spinningfactory/kloak/pull/340), [#363](https://github.com/spinningfactory/kloak/pull/363), [#364](https://github.com/spinningfactory/kloak/pull/364))

### Faster secret sync

Secrets are synced into the BPF maps as soon as an enabled Secret or its shadow changes, instead of every 5 seconds, with a resync every 5 minutes. A pod that loses access to a secret loses it at once. ([#349](https://github.com/spinningfactory/kloak/pull/349), [#350](https://github.com/spinningfactory/kloak/pull/350))

## Upgrade Notes

- **Restart kloak-enabled pods after upgrading.** Running pods keep the addresses they resolved before, and a connection to a real address gets no host-restricted secret.
- **Check the virtual IP ranges.** If the controller refuses to start because a range overlaps your cluster or nodes, set `controller.ebpf.virtualIPRange` to free ranges.
- **Check SNI against your annotations.** A client that connects through a name other than the one in `getkloak.io/hosts`, such as a short in-cluster Service name, now sends the placeholder. Use `controller.ebpf.sniCheck: audit` to find them first.
- **Applications that resolve names outside the pod's DNS** (hardcoded addresses, DNS over HTTPS) get no host-restricted secret. Restrict such secrets to an IP address.
- The chart adds RBAC to list nodes and service CIDRs, a Role in `kube-system` to watch kube-dns, and mounts the NRI socket directory `/var/run/nri`. See [Requirements](/reference/requirements).

## Other Changes

- A Secret key whose value can't be rewritten is left out of the shadow, and the Secret's other keys are still shadowed. ([#359](https://github.com/spinningfactory/kloak/pull/359))
- Kloak's tc programs attach first on their hook and pass every packet on, so they work alongside Cilium. CI now runs on Cilium with kube-proxy replacement. ([#341](https://github.com/spinningfactory/kloak/pull/341))
- Loads on Linux 7.2. ([#354](https://github.com/spinningfactory/kloak/pull/354))
- Smaller TLS data-plane programs, and ring buffer readers that block instead of polling. ([#332](https://github.com/spinningfactory/kloak/pull/332), [#351](https://github.com/spinningfactory/kloak/pull/351))
- New tracked versions: OpenSSL 4.1.0, Bun 1.4.3 and 1.4.4, BoringSSL 0.20261020.0. ([#348](https://github.com/spinningfactory/kloak/pull/348), [#323](https://github.com/spinningfactory/kloak/pull/323), [#336](https://github.com/spinningfactory/kloak/pull/336), [#337](https://github.com/spinningfactory/kloak/pull/337))

## Supported Versions

| Component | Versions |
|---|---|
| Linux kernel | 5.17+ (6.6+ for TCX) |
| Kubernetes | 1.28+ |
| OpenSSL | 3.0 -- 3.6 (4.0 -- 4.1 offsets tracked) |
| Go `crypto/tls` | 1.20 -- 1.27 |
| BoringSSL | Recent releases (one set of offsets) |
| Bun | 1.3.12 -- 1.4.4 |

See [Supported Runtimes](/guides/supported-runtimes) and [Requirements](/reference/requirements).
