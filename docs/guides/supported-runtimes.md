# Supported Runtimes

Kloak works by attaching eBPF uprobes to TLS library functions in your application's process. This page covers which TLS libraries and language runtimes are currently supported.

## Overview

Kloak currently supports these TLS stacks:

- **OpenSSL 3.0 -- 3.6** (and 4.0, offsets tracked) -- covers Python, Node.js, Ruby, PHP, curl, C/C++, and other languages or tools that use OpenSSL, either via `libssl.so` or statically linked into the executable
- **BoringSSL** -- C/C++ applications linking BoringSSL
- **Bun** single-executable builds -- Bun statically links BoringSSL
- **Go `crypto/tls`** (Go 1.20 -- 1.27) -- the standard library TLS implementation used by most Go applications

All stacks support host filtering via DNS-verified resolution and work with HTTP/1.1, HTTP/2, and raw TLS connections.

::: warning AES-GCM only
Rewriting requires an AES-128-GCM or AES-256-GCM cipher suite (TLS 1.2 or TLS 1.3). Connections that negotiate ChaCha20-Poly1305 send the placeholder unchanged.
:::

## Detection Strategy

When Kloak's controller detects a new pod, it resolves the container's PID and probes the process in this order:

1. **Go `crypto/tls`** -- Looks for the `crypto/tls.(*Conn).Write` symbol in the binary
2. **Bun** -- Looks for the embedded `bun/X.Y.Z` version string and attaches at a known `SSL_write` offset (Bun binaries are symbol-stripped)
3. **Statically linked OpenSSL/BoringSSL** -- Looks for `SSL_write` and `SSL_write_ex` symbols in the main executable
4. **Shared libraries** -- Scans the container filesystem (`/usr/lib`, `/usr/lib64`, `/lib`, `/lib64`, `/usr/local/lib`) for `libssl.so*`, `libboringssl.so*`, `libcrypto.so*`, and `libgnutls.so*`, then attaches to `SSL_write`/`SSL_write_ex` in them

Go and Bun stop at the first match. Steps 3 and 4 attach to every match. TLS libraries outside the scanned directories are not discovered.

## Host Filtering

Host filtering works the same way for **all** supported runtimes. It does not depend on the TLS library or protocol (HTTP/1.1, HTTP/2, or raw TLS).

Kloak uses **DNS-verified host filtering**: a kprobe on the kernel's `udp_recvmsg` captures DNS responses from trusted DNS servers, and connect tracepoints track TCP connections. At TLS write time, the destination hostname is resolved through this chain. See the [Host Filtering guide](/guides/host-filtering) for details.

::: tip
Unlike SNI-based approaches, DNS-verified filtering works for HTTP/2, raw TLS sockets, and any protocol. No application-level changes are needed.
:::

## How the Rewrite Works

The uprobe never modifies your application's plaintext buffer. Instead:

```
App calls SSL_write(ssl, buf, len)   (or tls.(*Conn).Write for Go)
  → eBPF uprobe scans buf for the kl:: prefix and records an XOR delta
    (placeholder XOR real value)
  → the TLS library encrypts the placeholder as usual
  → a tc program on the host side of the pod's veth XORs the delta into the
    AES-GCM ciphertext and recomputes the GCM tag
  → the server decrypts the real value
```

The real value never exists in the pod's memory.

## OpenSSL

**Status:** Supported (versions 3.0 -- 3.6)

Kloak attaches uprobes to `SSL_write` and `SSL_write_ex` in OpenSSL. This covers applications that link against `libssl.so` and applications that statically link OpenSSL into their executable.

### Supported Versions

| OpenSSL Version | Status |
|---|---|
| 4.0.x | Offsets tracked; no nightly end-to-end test yet |
| 3.6.x | Supported and nightly-tested |
| 3.5.x | Supported and nightly-tested |
| 3.4.x | Supported and nightly-tested |
| 3.3.x | Supported and nightly-tested |
| 3.2.x | Supported and nightly-tested |
| 3.1.x | Supported and nightly-tested |
| 3.0.x | Supported and nightly-tested |
| 1.1.x and older | Not supported |

If the detected OpenSSL version is not in this table, uprobes may still attach, but nothing is rewritten: the placeholder is sent as-is.

### Languages Using OpenSSL

Any language or tool that uses a supported OpenSSL version should work:

- **Python** -- `ssl` module wraps OpenSSL via `libssl.so`. Works out of the box with `requests`, `httpx`, `urllib3`, `aiohttp`, etc. Tested.
- **Node.js** -- Uses the OpenSSL bundled in the `node` binary (detected in the executable). Tested with `node:22-alpine`.
- **curl** -- Links against `libssl.so`. Tested.
- **Ruby** -- Uses OpenSSL via the `openssl` gem and `libssl.so`. Expected to work, untested.
- **PHP** -- Uses OpenSSL via the `php-openssl` extension. Expected to work, untested.
- **Rust** -- When using the `openssl` or `native-tls` crates with system OpenSSL. Expected to work, untested.
- **C/C++** -- Direct OpenSSL usage. Expected to work, untested.

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

// Node.js -- works out of the box via the bundled OpenSSL
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

# Node.js reports its bundled OpenSSL version
kubectl exec <pod> -- node -p process.versions.openssl
```

## BoringSSL

**Status:** Supported (C/C++ applications)

Kloak attaches to `SSL_write` in BoringSSL, whether it is statically linked or loaded as `libssl.so` / `libboringssl.so`. BoringSSL does not embed a version string, so Kloak uses one set of struct offsets; nightly CI checks recent BoringSSL release tags for layout changes.

Go built with `GOEXPERIMENT=boringcrypto` is **not** supported yet.

## Bun

**Status:** Supported (single-executable builds, Bun 1.3.12 -- 1.4.0)

Bun binaries are symbol-stripped, so Kloak identifies the Bun version from the `bun/X.Y.Z` string embedded in the binary and attaches at a pre-computed `SSL_write` offset. Offsets are tracked for Bun 1.3.12 -- 1.4.2 on amd64 and arm64. Other Bun versions are not detected.

::: warning Known issue: Bun 1.4.1+
Bun 1.4.1 and later send the first request in the same TCP segment as the end of the TLS handshake, which Kloak does not rewrite yet. Treat Bun 1.3.12 -- 1.4.0 as working.
:::

## Go (crypto/tls)

**Status:** Supported (Go 1.20 -- 1.27)

Go applications using the standard `crypto/tls` package are intercepted via a uprobe on `crypto/tls.(*Conn).Write`. Since Go statically links the TLS implementation into the binary, no shared library scanning is needed.

### Supported Versions

| Go Version | Status |
|---|---|
| 1.20.x -- 1.27.x | Supported and nightly-tested |
| 1.19.x and older | Not supported |

Kloak detects Go TLS struct offsets via DWARF debug info in the binary. If DWARF is not available, it falls back to a version-based lookup table.

### Limitations

- **Stripped binaries:** If compiled with `-ldflags="-s -w"`, the `crypto/tls.(*Conn).Write` symbol may not be resolvable. Ensure your Go binaries retain symbol tables (do not strip with `-s`) in production images used with Kloak. The `-w` flag (omit DWARF) is fine as long as symbols are preserved -- Kloak falls back to version-based offset lookup when DWARF is unavailable.
- **BoringCrypto:** Go binaries built with `GOEXPERIMENT=boringcrypto` are not supported yet.

## What Is NOT Supported

The following TLS stacks are not currently supported:

- **Java's built-in JSSE** -- TLS is implemented in pure Java, not via native OpenSSL
- **Go with `GOEXPERIMENT=boringcrypto`** -- not supported yet
- **GnuTLS** -- uprobes attach to `gnutls_record_send`, but ciphertext patching is not implemented yet; placeholders are sent unchanged
- **rustls** -- pure-Rust TLS implementation
- **.NET** -- not supported
- **mbedTLS** -- Different API (`mbedtls_ssl_write`)
- **s2n-tls** -- AWS's TLS library, different API
- **Custom TLS implementations** -- Any application implementing its own TLS handshake and encryption

::: tip
If your application uses an unsupported TLS stack, you may still benefit from Kloak's shadow secret mechanism. The application will read `kl::…` placeholder values, but they will be sent as-is without in-kernel rewriting.
:::

## Compatibility Matrix

| Runtime | TLS Library | eBPF Hook | Host Filtering | HTTP/2 | Notes |
|---|---|---|---|---|---|
| Python | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Tested |
| Node.js | OpenSSL (bundled in `node`) | `SSL_write` | DNS-verified | Yes | Tested with node:22-alpine |
| curl | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Tested |
| Ruby | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Expected to work, untested |
| PHP | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | Expected to work, untested |
| Rust | OpenSSL (libssl) | `SSL_write` | DNS-verified | Yes | When using native-tls/openssl crates; untested |
| C/C++ | OpenSSL or BoringSSL | `SSL_write` | DNS-verified | Yes | BoringSSL tested nightly |
| Bun | BoringSSL (static) | `SSL_write` (file offset) | DNS-verified | Yes | 1.3.12 -- 1.4.0; 1.4.1+ known issue |
| Go | crypto/tls | `tls.(*Conn).Write` | DNS-verified | Yes | Go 1.20 -- 1.27 |
| Go (boringcrypto) | BoringSSL | -- | -- | -- | Not supported yet |
| GnuTLS apps | GnuTLS | `gnutls_record_send` | -- | -- | Attaches, no rewrite yet |
| Java (JSSE) | JVM built-in | -- | -- | -- | Not supported |
