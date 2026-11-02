# Limits

This page lists all hard limits in Kloak. Most are imposed by eBPF program constraints (verifier complexity, map sizes, stack/memory budgets) and cannot be changed without recompiling the eBPF programs. Secret value limits are also enforced at admission time by the validating webhook.

The controller runs as a DaemonSet -- one pod per node -- so all BPF map limits are **per node**. Per-call limits apply to individual TLS writes (`SSL_write` or Go `crypto/tls.(*Conn).Write`) or DNS packets.

## Secret Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Min secret value length | **8 bytes** | Per secret value | `SECRET_KEY_LEN` / `minDataLen` | Shorter values are rejected by the validating webhook. Without the webhook, the key is left out of the shadow (the Secret's other keys are still shadowed), so pods get no value for it. |
| Max secret value length | **128 bytes** | Per secret value | `SECRET_MAX_LEN` / `maxDataLen` | Longer values are rejected by the validating webhook. If the webhook is not installed they are truncated, producing an incorrect rewrite. |
| HPACK Huffman feasibility | -- | Per secret value | `CanShadow` | The value's HPACK Huffman bit density must be achievable by a same-length `kl::` placeholder. Values that can't be matched are rejected ("use a different value or a longer secret"). |
| Max secrets per TLS write | **4** | Per TLS write | `XOR_MAX_MATCHES` | Maximum number of `kl::` placeholders rewritten in a single TLS write. Additional placeholders are sent unmodified. |
| Max secret map entries | **4096** | Per node | `secret_map` max entries | Each secret value uses two entries (plaintext plus its HTTP/2 HPACK Huffman form), so about 2048 secret values per node. |
| Max secret bindings | **65536** | Per node | `secret_acl` max entries | (container, placeholder) pairs allowed to be rewritten. Each container is bound to every key of every secret its pod references, in plaintext and HPACK Huffman form. |
| Placeholder key length | **8 bytes** | Per secret | `SECRET_KEY_LEN` | BPF map lookup key size (`kl::` + 4 characters). The first 8 bytes of each placeholder must be unique; the controller regenerates on collision. |

## Protocol Limits

| Limit | Value | Scope | Description |
|---|---|---|---|
| Cipher suites | **AES-128-GCM, AES-256-GCM** | Per connection | Only AES-GCM suites (TLS 1.2 and 1.3) are rewritten. Connections using ChaCha20-Poly1305 or other suites send the placeholder. |
| Destination address family | **IPv4 and IPv6** | Per connection | A secret restricted to a hostname is only rewritten over IPv6 when an IPv6 virtual IP range is configured (it is by default). |

## Host Filtering Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max hostname length | **63 characters** | Per hostname | `maxHostLen` (`MAX_HOST_LEN` = 64) | Longer hostnames are rejected by the validating webhook. Without the webhook, the secret is skipped and never rewritten. |
| Hosts per secret | **1** | Per secret | `allowed_host` field | `getkloak.io/hosts` takes a single hostname, IP, or `*`. A comma-separated value is rejected by the validating webhook ([#102](https://github.com/spinningfactory/kloak/issues/102)). |
| Max hosts with a virtual IP | **1024** | Per node | `vip_host_ip` max entries | Unique hostnames across all `getkloak.io/hosts` annotations. |
| Max virtual IP reservations | **4096** | Per node | `vip_ip_host` max entries | Virtual IPs of current hosts, IPv4 and IPv6, plus those of removed hosts that are still reserved. |
| Virtual IP range size | **IPv4 /19 or larger, IPv6 /115 or larger** | Per cluster | `--virtual-ip-range` | Smaller ranges are refused at startup. |
| Real addresses per virtual IP | **4** | Per virtual IP | `VIP_UPSTREAM_SLOTS` | Addresses kept from the DNS answer; a connect to the virtual IP goes to one of them at random. |
| Max rewritten (pod, host) pairs | **16384** | Per node | `vip_pod_host` max entries | Pods whose DNS answers for a host are rewritten: one pair per pod IP and host of a secret it references. |
| Max address records per DNS answer | **8** | Per DNS response | `DNS_MAX_ADDR_RECORDS` | An answer with more A or AAAA records is left unchanged. |
| Max DNS message size | **512 bytes** | Per DNS response | `MAX_DNS_PKT` | Larger answers, and answers over TCP, are left unchanged. |
| Max trusted DNS servers | **32** | Per node | `trusted_dns_servers` max entries | kube-dns's ClusterIPs and endpoint addresses plus `controller.dns.trustedServers`. |

An answer left unchanged carries the host's real addresses, so connections made with them get no host-restricted secret.

## Connection Tracking Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max tracked connections | **16384** | Per node | `conn_ip_map` max entries | LRU cache of the TCP connections processes made (fd → destination). |
| Max sockets with a host | **65536** | Per node | `vip_sock_host` max entries | LRU cache of sockets that connected through a virtual IP. A socket whose entry was evicted gets no host-restricted secret. |
| Max socket destinations | **65536** | Per node | `vip_sock_dst` max entries | LRU cache of the address and port each TCP socket connected to. |
| Max SNI entries | **65536** | Per node | `sni_state` max entries | LRU cache of each connection's SNI. A connection whose entry was evicted gets no host-restricted secret. |

## Process and Container Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max tracked processes | **16384** | Per node | `tracked_tgids` max entries | Container processes seen by the exec tracepoint. |
| Max tracked containers | **4096** | Per node | `tracked_cgroups` max entries | Containers with eBPF enabled. |

## TLS Connection Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max TLS connection state entries | **4096** | Per node | `tls_conn_state` max entries | Per-connection GHASH H key cache. LRU eviction when full. |
| Max pending XOR patches | **4096** | Per node | `xor_pending` max entries | Pending ciphertext patches between uprobe and kprobe. |
| Max patches per TLS write | **4** | Per TLS write | `XOR_MAX_PATCHES` | Ciphertext patches carried from the uprobe to the tc program for one TLS write. |

## Observability Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Violation events ring buffer | **64 KB** | Per node | `secret_binding_events` max entries | Secret binding and SNI violations reported to the controller. When full, events are dropped (the rewrite decision is not affected). |
| Process events ring buffer | **64 KB** | Per node | `proc_events` max entries | Ring buffer for exec/exit events. |
