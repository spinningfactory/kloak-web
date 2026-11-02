# Supported Runtimes

Kloak works by attaching eBPF uprobes to TLS library functions in your application's process. This page covers which TLS libraries and language runtimes are supported in this release.

## Overview

Kloak supports these TLS stacks:

- **OpenSSL 3.0 -- 3.5** -- covers Python, Node.js, Ruby, PHP, curl, C/C++, and other languages or tools that use OpenSSL, either via `libssl.so` or statically linked into the executable (see the [known issues](#known-issues))
- **Go `crypto/tls`** (Go 1.25 -- 1.26) -- the standard library TLS implementation used by most Go applications

Both support host filtering via DNS-verified resolution and work with HTTP/1.1 and raw TLS connections. HTTP/2 has a [known issue](#http-2).

::: warning AES-GCM only
Rewriting requires an AES-128-GCM or AES-256-GCM cipher suite (TLS 1.2 or TLS 1.3). Connections that negotiate ChaCha20-Poly1305 send the placeholder unchanged.
:::

## Detection Strategy

When Kloak's controller detects a new pod, it resolves the container's PID and probes the process in this order:

1. **Go `crypto/tls`** -- Looks for the `crypto/tls.(*Conn).Write` symbol in the binary
2. **Statically linked OpenSSL** -- Looks for `SSL_write` and `SSL_write_ex` symbols in the main executable
3. **Shared libraries** -- Scans `/usr/lib`, `/lib`, and `/usr/local/lib` in the container filesystem, and their immediate subdirectories (such as `/usr/lib/x86_64-linux-gnu`), for `libssl.so*`, `libboringssl.so*`, `libcrypto.so*`, and `libgnutls.so*`, then attaches to `SSL_write`/`SSL_write_ex` in them

Go stops at the first match. Steps 2 and 3 attach to every match. TLS libraries outside the scanned directories (for example in `/usr/lib64` or deeper subdirectories) are not discovered.

## Host Filtering

Host filtering works the same way for **all** supported runtimes. It does not depend on the TLS library or protocol.

Kloak uses **DNS-verified host filtering**: a kprobe on the kernel's `udp_recvmsg` captures DNS responses from trusted DNS servers, and connect tracepoints track TCP connections. At TLS write time, the destination hostname is resolved through this chain. See the [Host Filtering guide](/guides/host-filtering) for details.

## How the Rewrite Works

The uprobe never modifies your application's plaintext buffer. Instead:

```
App calls SSL_write(ssl, buf, len)   (or tls.(*Conn).Write for Go)
  → eBPF uprobe scans buf for the kloak: prefix and records an XOR delta
    (placeholder XOR real value)
  → the TLS library encrypts the placeholder as usual
  → a tc program on the pod's eth0 XORs the delta into the AES-GCM
    ciphertext and recomputes the GCM tag
  → the server decrypts the real value
```

The real value never exists in the pod's memory.

## OpenSSL

**Status:** Supported (versions 3.0 -- 3.5, see the [known issues](#known-issues))

Kloak attaches uprobes to `SSL_write` and `SSL_write_ex` in OpenSSL. This covers applications that link against `libssl.so` and applications that statically link OpenSSL into their executable, such as Node.js.

To patch the ciphertext, Kloak needs the connection's GCM hash key. It captures the key with uprobes on libcrypto's `EVP_CipherInit_ex` when the cipher is keyed, or else reads it from OpenSSL's structures at version-specific offsets.

### Supported Versions

| OpenSSL Version | Status |
|---|---|
| 3.5.x | Supported |
| 3.4.x | Supported |
| 3.3.x | Supported |
| 3.2.x | Supported |
| 3.1.x | Not rewritten (known issue) |
| 3.0.x | Not rewritten (known issue) |
| 3.6 and later | Not supported |
| 1.1.x and older | Not supported |

If the detected OpenSSL version is not in this table, uprobes may still attach, but nothing is rewritten: the placeholder is sent as-is.

### Languages Using OpenSSL

Any language or tool that uses a supported OpenSSL version should work:

- **Python** -- `ssl` module wraps OpenSSL via `libssl.so`. Works out of the box with `requests`, `httpx`, `urllib3`, `aiohttp`, etc.
- **Node.js** -- Uses the OpenSSL bundled in the `node` binary (detected in the executable). Check the bundled version (below): Node.js 22 and older bundle OpenSSL 3.0, which this release does not rewrite.
- **curl** -- Links against `libssl.so`.
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

## Go (crypto/tls)

**Status:** Supported (Go 1.25 -- 1.26)

Go applications using the standard `crypto/tls` package are intercepted via a uprobe on `crypto/tls.(*Conn).Write`. Since Go statically links the TLS implementation into the binary, no shared library scanning is needed.

### Supported Versions

| Go Version | Status |
|---|---|
| 1.25.x -- 1.26.x | Supported |
| 1.24.x and older | Not supported (offsets for Go 1.20 -- 1.24 were added in v0.2.0) |

Kloak detects Go TLS struct offsets via DWARF debug info in the binary. If DWARF is not available, it falls back to a version-based lookup table.

### Limitations

- **Stripped binaries:** If compiled with `-ldflags="-s -w"`, the `crypto/tls.(*Conn).Write` symbol may not be resolvable. Ensure your Go binaries retain symbol tables (do not strip with `-s`) in production images used with Kloak. The `-w` flag (omit DWARF) is fine as long as symbols are preserved -- Kloak falls back to version-based offset lookup when DWARF is unavailable.
- **BoringCrypto:** Go binaries built with `GOEXPERIMENT=boringcrypto` are not supported.
- **HTTP/2:** Go's `net/http` uses HTTP/2 for HTTPS by default; see the [HTTP/2 known issue](#http-2).

## Known Issues

These are fixed in later releases.

### OpenSSL 3.0 and 3.1

Kloak reads the connection's socket from the OpenSSL `SSL` object at an offset that is only correct for OpenSSL 3.2 and later. On 3.0 and 3.1 it misreads it and skips the rewrite, so the placeholder is sent. Fixed in v0.2.0.

### OpenSSL 3.1+ on CPUs with AVX-512

On x86 CPUs with AVX-512 and VAES (Intel Ice Lake or newer, AMD Zen 4 or newer), OpenSSL 3.1 and later run GCM through a code path that doesn't store the hash key where Kloak reads it. Kloak skips the rewrite and the placeholder is sent. Fixed in v0.2.0; see [Chasing a Flake Into OpenSSL's GCM Path](https://getkloak.io/blog/the-h-that-wasnt-there/).

### HTTP/2

HTTP/2 sends headers HPACK-encoded, usually in Huffman form. Kloak rewrites the placeholder's Huffman bytes with the real value's, but the HPACK length of the header can't change. When the real value's Huffman encoding is shorter than the placeholder's (the usual case, since placeholders use uppercase letters, which have long Huffman codes), Kloak pads it with whole bytes of `1` bits. HTTP/2 decoders reject padding longer than 7 bits, so the server refuses the request. Use HTTP/1.1 for requests that carry a protected secret. Fixed in v0.2.0, which generates placeholders with exactly the real value's Huffman length.

## What Is NOT Supported

The following TLS stacks are not supported in this release:

- **BoringSSL** -- uprobes attach to `SSL_write`, but Kloak can't recover the GCM hash key, so placeholders are sent unchanged (added in v0.2.0)
- **Bun** -- Bun binaries are symbol-stripped, so no `SSL_write` is found (added in v0.2.0)
- **Java's built-in JSSE** -- TLS is implemented in pure Java, not via native OpenSSL
- **Go with `GOEXPERIMENT=boringcrypto`**
- **GnuTLS** -- uprobes attach to `gnutls_record_send`, but ciphertext patching is not implemented; placeholders are sent unchanged
- **rustls** -- pure-Rust TLS implementation
- **.NET** -- not supported
- **mbedTLS** -- Different API (`mbedtls_ssl_write`)
- **s2n-tls** -- AWS's TLS library, different API
- **Custom TLS implementations** -- Any application implementing its own TLS handshake and encryption

::: tip
If your application uses an unsupported TLS stack, you may still benefit from Kloak's shadow secret mechanism. The application will read `kloak:…` placeholder values, but they will be sent as-is without in-kernel rewriting.
:::

## Compatibility Matrix

| Runtime | TLS Library | eBPF Hook | Host Filtering | HTTP/2 | Notes |
|---|---|---|---|---|---|
| Python | OpenSSL (libssl) | `SSL_write` | DNS-verified | Known issue | OpenSSL 3.2 -- 3.5 |
| Node.js | OpenSSL (bundled in `node`) | `SSL_write` | DNS-verified | Known issue | Bundled OpenSSL must be 3.2 -- 3.5 |
| curl | OpenSSL (libssl) | `SSL_write` | DNS-verified | Known issue | Use `--http1.1` |
| Ruby | OpenSSL (libssl) | `SSL_write` | DNS-verified | Known issue | Expected to work, untested |
| PHP | OpenSSL (libssl) | `SSL_write` | DNS-verified | Known issue | Expected to work, untested |
| Rust | OpenSSL (libssl) | `SSL_write` | DNS-verified | Known issue | When using native-tls/openssl crates; untested |
| C/C++ | OpenSSL | `SSL_write` | DNS-verified | Known issue | Expected to work, untested |
| Go | crypto/tls | `tls.(*Conn).Write` | DNS-verified | Known issue | Go 1.25 -- 1.26 |
| C/C++ | BoringSSL | `SSL_write` | -- | -- | Attaches, no rewrite |
| Bun | BoringSSL (static) | -- | -- | -- | Not supported |
| Go (boringcrypto) | BoringSSL | -- | -- | -- | Not supported |
| GnuTLS apps | GnuTLS | `gnutls_record_send` | -- | -- | Attaches, no rewrite |
| Java (JSSE) | JVM built-in | -- | -- | -- | Not supported |
