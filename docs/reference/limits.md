# Limits

This page lists all hard limits in Kloak. These limits are imposed by eBPF program constraints (verifier complexity, map sizes, stack/memory budgets) and cannot be changed without recompiling the eBPF programs.

## Secret Limits

| Limit | Value | Constant | Description |
|---|---|---|---|
| Max secret value length | **128 bytes** | `SECRET_MAX_LEN` | Maximum length of a secret value that can be rewritten. Longer values are truncated. Covers most API keys, tokens, and passwords. |
| Max secrets per TLS write | **4** | `XOR_MAX_MATCHES` | Maximum number of `kloak:` placeholders detected and rewritten in a single `SSL_write` call. |
| Max secrets tracked | **1024** | `secret_map` max entries | Total number of distinct secret entries (shadow prefix → real value) across all pods on a node. |
| Placeholder prefix length | **8 bytes** | `SECRET_KEY_LEN` | BPF map lookup key size (`kloak:XX`). First 8 bytes of each placeholder must be unique. |
| Full prefix verification | **42 bytes** | `SECRET_PREFIX_MAX` | Maximum prefix bytes verified after the initial 8-byte key match. |

## Host Filtering Limits

| Limit | Value | Constant | Description |
|---|---|---|---|
| Max hostname length | **64 characters** | `MAX_HOST_LEN` | Hostnames longer than 64 characters are truncated in BPF maps. |
| Hosts per secret | **1** | `allowed_host` field | Only the first hostname in a comma-separated `getkloak.io/hosts` list is enforced ([#102](https://github.com/spinningfactory/kloak/issues/102)). |
| Max watched hostnames | **256** | `watched_hosts` max entries | Total unique hostnames from all secrets that DNS responses are captured for. |
| Max DNS cache entries | **8192** | `dns_ip_map` max entries | LRU cache of DNS-verified IP → hostname mappings. Oldest entries evicted when full. |
| Max DNS answers parsed | **8** | `MAX_DNS_ANSWERS` | A/AAAA records parsed per DNS response packet. |
| Max DNS packet size | **512 bytes** | `MAX_DNS_PKT` | Maximum DNS response payload parsed by the kprobe. Standard DNS limit. |
| Max trusted DNS servers | **32** | `trusted_dns_servers` max entries | Number of DNS server IPs in the trusted whitelist. |

## Connection Tracking Limits

| Limit | Value | Constant | Description |
|---|---|---|---|
| Max tracked connections | **16384** | `conn_ip_map` max entries | LRU cache of TCP connections (fd → destination IP) per node. |
| Max SSL fd cache entries | **4096** | `ssl_fd_map` max entries | LRU cache mapping SSL pointers to file descriptors. |
| Max verified fd entries | **16384** | `last_verified_fd` max entries | Cache of last DNS-verified fd per process. |

## Process and Container Limits

| Limit | Value | Constant | Description |
|---|---|---|---|
| Max tracked processes | **16384** | `tracked_tgids` max entries | Processes opted in for DNS/connect tracking per node. |
| Max tracked containers | **256** | `tracked_cgroups` max entries | Containers with eBPF enabled per node. |

## TLS Connection Limits

| Limit | Value | Constant | Description |
|---|---|---|---|
| Max TLS connection state entries | **4096** | `tls_conn_state` max entries | Per-connection GHASH H key cache. LRU eviction when full. |
| Max pending XOR patches | **4096** | `xor_pending` max entries | Pending ciphertext patches between uprobe and kprobe. |
| Max patches per packet | **4** | `XOR_MAX_PATCHES` | Ciphertext patches applied per outbound packet in TC egress. |

## Observability Limits

| Limit | Value | Constant | Description |
|---|---|---|---|
| TLS events ring buffer | **256 KB** | `tls_events` max entries | Ring buffer for rewrite events sent to userspace. |
| Process events ring buffer | **64 KB** | `proc_events` max entries | Ring buffer for exec/exit events. |
