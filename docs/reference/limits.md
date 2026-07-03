# Limits

This page lists all hard limits in Kloak. These limits are imposed by eBPF program constraints (verifier complexity, map sizes, stack/memory budgets) and cannot be changed without recompiling the eBPF programs.

The controller runs as a DaemonSet -- one pod per node -- so all BPF map limits are **per node**. Per-call limits apply to individual `SSL_write` invocations or DNS packets.

## Secret Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max secret value length | **128 bytes** | Per secret | `SECRET_MAX_LEN` | Maximum length of a secret value that can be rewritten. Longer values are truncated. Covers most API keys, tokens, and passwords. |
| Max secrets per TLS write | **4** | Per `SSL_write` call | `XOR_MAX_MATCHES` | Maximum number of `kloak:` placeholders detected and rewritten in a single `SSL_write` call. |
| Max secrets tracked | **1024** | Per node | `secret_map` max entries | Total number of distinct secret entries (shadow prefix → real value) across all pods on a node. |
| Placeholder prefix length | **8 bytes** | Per secret | `SECRET_KEY_LEN` | BPF map lookup key size (`kloak:XX`). First 8 bytes of each placeholder must be unique. |
| Full prefix verification | **42 bytes** | Per secret | `SECRET_PREFIX_MAX` | Maximum prefix bytes verified after the initial 8-byte key match. |

## Host Filtering Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max hostname length | **64 characters** | Per hostname | `MAX_HOST_LEN` | Hostnames longer than 64 characters are truncated in BPF maps. |
| Hosts per secret | **1** | Per secret | `allowed_host` field | `getkloak.io/hosts` takes a single hostname, IP, or `*`. A comma-separated value is rejected by the validating webhook ([#102](https://github.com/spinningfactory/kloak/issues/102)). |
| Max watched hostnames | **256** | Per node | `watched_hosts` max entries | Total unique hostnames from all secrets that DNS responses are captured for. |
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
| Max tracked containers | **256** | Per node | `tracked_cgroups` max entries | Containers with eBPF enabled. |

## TLS Connection Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| Max TLS connection state entries | **4096** | Per node | `tls_conn_state` max entries | Per-connection GHASH H key cache. LRU eviction when full. |
| Max pending XOR patches | **4096** | Per node | `xor_pending` max entries | Pending ciphertext patches between uprobe and kprobe. |
| Max patches per packet | **4** | Per packet | `XOR_MAX_PATCHES` | Ciphertext patches applied per outbound packet in TC egress. |

## Observability Limits

| Limit | Value | Scope | Constant | Description |
|---|---|---|---|---|
| TLS events ring buffer | **256 KB** | Per node | `tls_events` max entries | Ring buffer for rewrite events sent to userspace. |
| Process events ring buffer | **64 KB** | Per node | `proc_events` max entries | Ring buffer for exec/exit events. |
