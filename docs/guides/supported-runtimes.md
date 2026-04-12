# Supported Runtimes

Kloak works by attaching eBPF uprobes to TLS library functions in your application's process. This page covers which TLS libraries and language runtimes are currently supported.

## Overview

Kloak currently supports two TLS stacks:

- **OpenSSL 3.2 -- 3.5** -- covers Python, Node.js, Ruby, PHP, Rust, C/C++, curl, and any other language or tool that links against `libssl.so`
- **Go `crypto/tls`** (Go 1.25+) -- the standard library TLS implementation used by most Go applications

Both stacks support host filtering via DNS-verified resolution and work with HTTP/1.1, HTTP/2, and raw TLS connections.

## Detection Strategy

When Kloak's controller detects a new pod, it resolves the container's PID and probes the process in this order:

1. **Go `crypto/tls`** -- Looks for the `crypto/tls.(*Conn).Write` symbol in the binary
2. **OpenSSL (statically linked)** -- Looks for `SSL_write` and `SSL_write_ex` symbols in the main executable
3. **OpenSSL (dynamically linked)** -- Scans `/proc/<pid>/maps` for shared libraries matching `libssl.so*` or `libcrypto.so*`, then probes those for `SSL_write`/`SSL_write_ex`

The first successful attachment wins.

## Host Filtering

Host filtering works the same way for **all** supported runtimes. It does not depend on the TLS library or protocol (HTTP/1.1, HTTP/2, or raw TLS).

Kloak uses **DNS-verified host filtering**: a kprobe on the kernel's `udp_recvmsg` captures DNS responses, and connect tracepoints track TCP connections. At TLS write time, the destination hostname is resolved through this chain. See the [Host Filtering guide](/guides/host-filtering) for details.

::: tip
Unlike SNI-based approaches, DNS-verified filtering works for HTTP/2, raw TLS sockets, and any protocol. No application-level changes are needed.
:::

## OpenSSL

**Status:** Fully supported (versions 3.2 -- 3.5)

Kloak attaches uprobes to `SSL_write` and `SSL_write_ex` in OpenSSL. This covers any application that links against `libssl.so`, whether statically or dynamically.

### Supported Versions

| OpenSSL Version | Status |
|---|---|
| 3.5.x | Supported and tested |
| 3.4.x | Supported and tested |
| 3.3.x | Supported and tested |
| 3.2.x | Supported and tested |
| 3.0.x -- 3.1.x | Not yet supported (different internal struct layout) |
| 1.1.x and older | Not supported |

::: warning
OpenSSL 3.0 and 3.1 use a different internal struct layout (3-hop pointer chain vs 4-hop in 3.2+). Support is planned but not yet implemented.
:::

### How It Works

```
App calls SSL_write(ssl, buf, len)
  → eBPF uprobe fires, scans buf for kloak: prefix
  → Real secret injected before encryption
  → OpenSSL encrypts and sends the real value
```

### Languages Using OpenSSL

Any language or tool that links against OpenSSL is automatically supported:

- **Python** -- `ssl` module wraps OpenSSL via `libssl.so`. Works out of the box with `requests`, `httpx`, `urllib3`, `aiohttp`, etc.
- **Node.js** -- Links against system OpenSSL on Alpine-based images (`node:*-alpine`). Tested with `node:22-alpine`.
- **Ruby** -- Uses OpenSSL via the `openssl` gem and `libssl.so`.
- **PHP** -- Uses OpenSSL via the `php-openssl` extension.
- **Rust** -- When using the `openssl` or `native-tls` crates with system OpenSSL.
- **C/C++** -- Direct OpenSSL usage.
- **curl** -- Links against `libssl.so`.

```python
import requests

# Python -- works out of the box, no special configuration needed
response = requests.get(
    "https://api.stripe.com/v1/charges",
    headers={"Authorization": f"Bearer {secret}"},
)
```

```javascript
const https = require('https');

// Node.js (Alpine) -- works out of the box via system OpenSSL
https.request({
  hostname: 'api.stripe.com',
  path: '/v1/charges',
  headers: { 'Authorization': `Bearer ${secret}` },
}, (res) => { /* ... */ });
```

### Checking Your OpenSSL Version

To check which OpenSSL version a container uses:

```bash
# For dynamically linked applications
kubectl exec <pod> -- openssl version

# Or check the linked library
kubectl exec <pod> -- ldd /usr/bin/python3 | grep ssl
```

## Go (crypto/tls)

**Status:** Fully supported (Go 1.25+)

Go applications using the standard `crypto/tls` package are intercepted via a uprobe on `crypto/tls.(*Conn).Write`. Since Go statically links the TLS implementation into the binary, no shared library scanning is needed.

### Supported Versions

| Go Version | Status |
|---|---|
| 1.26.x | Supported |
| 1.25.x | Supported and tested |
| 1.24.x and older | Not yet supported (different struct offsets) |

Kloak detects Go TLS struct offsets via DWARF debug info in the binary. If DWARF is not available, it falls back to a version-based lookup table.

### How It Works

```
App calls http.Client.Do(req)
  → net/http serializes headers + body
  → tls.(*Conn).Write(plaintext)
  → eBPF uprobe fires, scans for kloak: prefix
  → Real secret injected before encryption
```

### Limitations

- **Stripped binaries:** If compiled with `-ldflags="-s -w"`, the `crypto/tls.(*Conn).Write` symbol may not be resolvable. Ensure your Go binaries retain symbol tables (do not strip with `-s`) in production images used with Kloak. The `-w` flag (omit DWARF) is fine as long as symbols are preserved -- Kloak falls back to version-based offset lookup when DWARF is unavailable.
- **Connection pooling:** Go's `http.Transport` reuses TLS connections. The DNS-verified host is cached on first successful resolution, so subsequent writes on the same connection use the cached hostname.

## What Is NOT Supported

The following TLS stacks are not currently supported. The eBPF uprobes have no compatible function to attach to:

- **Java's built-in JSSE** -- TLS is implemented in pure Java, not via native OpenSSL
- **BoringSSL** -- Different internal struct layout than OpenSSL. No offset support. Node.js images that statically link BoringSSL instead of system OpenSSL are not supported
- **GnuTLS** -- Different API (`gnutls_record_send`), different internal struct layout
- **mbedTLS** -- Different API (`mbedtls_ssl_write`)
- **s2n-tls** -- AWS's TLS library, different API
- **Custom TLS implementations** -- Any application implementing its own TLS handshake and encryption

::: tip
If your application uses an unsupported TLS stack, you may still benefit from Kloak's shadow secret mechanism. The application will read `kloak:<ULID>` values, but they will be sent as-is without in-kernel rewriting.
:::

## Compatibility Matrix

| Runtime | TLS Library | eBPF Hook | Host Filtering | HTTP/2 | Notes |
|---|---|---|---|---|---|
| Python | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Works out of the box |
| Ruby | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Via system OpenSSL |
| PHP | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Via php-openssl |
| Rust | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | When using native-tls |
| C/C++ | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Direct OpenSSL usage |
| curl | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Via system OpenSSL |
| Node.js (Alpine) | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Via system OpenSSL; tested with node:22-alpine |
| Go | crypto/tls | `tls.(*Conn).Write` | DNS-verified | Yes | Go 1.25+ required |
| Java (JSSE) | JVM built-in | -- | -- | -- | Not supported |
