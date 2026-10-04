# Limits

This page lists all hard limits in Kloak. Most are imposed by eBPF program constraints (verifier complexity, map sizes, stack/memory budgets) and cannot be changed without recompiling the eBPF programs. Secret value limits are also enforced at admission time by the validating webhook.

The controller runs as a DaemonSet -- one pod per node -- so all BPF map limits are **per node**. Per-call limits apply to individual TLS writes (`SSL_write` or Go `crypto/tls.(*Conn).Write`) or DNS packets.

## Secret Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Min secret value length | **8 bytes** | Per secret value | `SECRET_KEY_LEN` / `minDataLen` | Shorter values are rejected by the validating webhook. Without the webhook, no shadow is created for the whole Secret, so pods referencing it are denied. |
| Max secret value length | **128 bytes** | Per secret value | `SECRET_MAX_LEN` / `maxDataLen` | Longer values are rejected by the validating webhook. If the webhook is not installed they are truncated, producing an incorrect rewrite. |
| HPACK Huffman feasibility | -- | Per secret value | `CanShadow` | The value's HPACK Huffman bit density must be achievable by a same-length `kl::` placeholder. Values that can't be matched are rejected ("use a different value or a longer secret"). |
| Max secrets per TLS write | **4** | Per TLS write | `XOR_MAX_MATCHES` | Maximum number of `kl::` placeholders rewritten in a single TLS write. Additional placeholders are sent unmodified. |
| Max secret map entries | **4096** | Per node | `secret_map` max entries | Each secret value uses two entries (plaintext plus its HTTP/2 HPACK Huffman form), so about 2048 secret values per node. |
| Placeholder key length | **8 bytes** | Per secret | `SECRET_KEY_LEN` | BPF map lookup key size (`kl::` + 4 characters). The first 8 bytes of each placeholder must be unique; the controller regenerates on collision. |

## Protocol Limits

| Limit | Value | Scope | Description |
|---|---|---|---|
| Cipher suites | **AES-128-GCM, AES-256-GCM** | Per connection | Only AES-GCM suites (TLS 1.2 and 1.3) are rewritten. Connections using ChaCha20-Poly1305 or other suites send the placeholder. |
| Destination address family | **IPv4 only** | Per connection | Only IPv4 destinations are rewritten. |

## Host Filtering Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max hostname length | **63 characters** | Per hostname | `maxHostLen` (`MAX_HOST_LEN` = 64) | Longer hostnames are rejected by the validating webhook. Without the webhook, the secret is skipped and never rewritten. |
| Hosts per secret | **1** | Per secret | `allowed_host` field | `getkloak.io/hosts` takes a single hostname, IP, or `*`. A comma-separated value is rejected by the validating webhook ([#102](https://github.com/spinningfactory/kloak/issues/102)). |
| Max watched hostnames | **1024** | Per node | `watched_hosts` max entries | Total unique hostnames from all secrets that DNS responses are captured for. |
| Max DNS cache entries | **8192** | Per node | `dns_ip_map` max entries | LRU cache of DNS-verified IP → hostname mappings. Oldest entries evicted when full. |
| Max DNS answers parsed | **8** | Per DNS response | `MAX_DNS_ANSWERS` | A/AAAA records parsed per DNS response packet. |
| Max DNS packet size | **512 bytes** | Per DNS response | `MAX_DNS_PKT` | Maximum DNS response payload parsed by the kprobe. Standard DNS limit. |
| Max trusted DNS servers | **32** | Per node | `trusted_dns_servers` max entries | Number of DNS server IPs in the trusted whitelist. |

## Connection Tracking Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max tracked connections | **16384** | Per node | `conn_ip_map` max entries | LRU cache of TCP connections (fd → destination IP). |
| Max SSL fd cache entries | **4096** | Per node | `ssl_fd_map` max entries | LRU cache mapping SSL pointers to file descriptors. |
| Max verified fd entries | **16384** | Per node | `last_verified_fd` max entries | Cache of last DNS-verified fd per process. |

## Process and Container Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max tracked processes | **16384** | Per node | `tracked_tgids` max entries | Processes opted in for DNS/connect tracking. |
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
| TLS events ring buffer | **256 KB** | Per node | `tls_events` max entries | Reserved for rewrite events; currently unused (no eBPF program writes to it). |
| Process events ring buffer | **64 KB** | Per node | `proc_events` max entries | Ring buffer for exec/exit events. |
