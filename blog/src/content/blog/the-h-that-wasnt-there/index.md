---
title: 'Chasing a Flake Into OpenSSL''s GCM Path'
description: 'A CI flake that turned out to be a deterministic failure on AVX-512 CPUs, and how kloak now recovers OpenSSL''s GCM hash subkey without running AES in BPF'
pubDate: 2026-10-21
author: 'Kloak Team'
tags: ['ebpf', 'tls', 'openssl', 'debugging']
---

kloak reads OpenSSL's internal structures at offsets that move between releases. Until June 2026, our E2E suite only exercised whatever OpenSSL versions our demo images happened to ship. In May, a bug slipped through that gap: a hardcoded offset that was only right for OpenSSL 3.2 and later [silently broke every 3.0 and 3.1 caller](https://github.com/spinningfactory/kloak/pull/222), and we only found it by hand on an Ubuntu machine.

In June we closed that gap with a nightly job that builds OpenSSL from source for every tracked release, checks our offsets against each one, and runs the E2E suite on all of them. Within a week it was failing in a way we couldn't explain, and it kept failing until October. Each night one or two versions failed at random, and the symptom never changed: a `kl::` placeholder left the TLS connection instead of the real secret. It looked like a race condition. It wasn't.

The bug had been there since kloak first supported OpenSSL in April. The nightly was just the first thing to run enough OpenSSL versions on enough different machines to hit it.

This is the story of chasing that bug, the fix we almost shipped, and the one we did ship in [kloak#313](https://github.com/spinningfactory/kloak/pull/313). Along the way it's a tour of how kloak rewrites secrets inside encrypted traffic without ever handing them to the application.

## How kloak works

kloak operates under an unconventional threat model: treating the application itself as the adversary. Consequently, secrets are never exposed to the app. Instead, a mutating webhook replaces each Secret with a shadow object containing a randomized `kl::…` placeholder matching its exact length.

When the app writes to TLS, an eBPF uprobe on the library's write function spots the placeholder and checks the destination against the secret's policy. The real value is then patched straight into the encrypted record on its way out, by a tc program. The receiver decrypts the real secret. The app, and anything else inside the pod, only ever sees the placeholder.

The complication lies in GCM's authentication tag: altering the ciphertext invalidates the tag. kloak is capable of recalculating this tag within the kernel, but it requires the connection's hash subkey **H** to do so. Without H, an authentic tag cannot be generated, preventing any payload modification. So acquiring **H** is vital for kloak to perform the rewrite.

### Specific to each stack, by design

Kloak avoids terminating TLS altogether. Instead, it attaches directly to each supported stack (OpenSSL, BoringSSL, Go crypto/tls, Bun) right where key material and unencrypted text reside. This approach is an intentional compromise: it eliminates the need for proxies, trust store modifications, or bypassing certificate pinning, though it demands reading internal structures at offsets that shift across releases.

To manage this overhead, we rely heavily on automation. Offsets for every supported architecture and release are automatically extracted using a dedicated discovery tool for each stack. These discoveries and the full E2E test suite are executed nightly across all tracked versions, with new upstream releases submitted automatically via pull requests.

## Where kloak finds H

H is AES_K(0¹²⁸). Every TLS library computes it at key setup, and each keeps it differently:

| Runtime | Where H lives | How kloak gets it |
| :---- | :---- | :---- |
| Go crypto/tls | Stored as H·2, not H | Read it and invert the doubling |
| BoringSSL / Bun | Not stored, only the AES key schedule | Recompute AES_K(0) in the kernel |
| OpenSSL 3.x | `GCM128_CONTEXT.H` in the provider context | Read it at a calibrated offset |

## The symptom: a flake that moved around

The OpenSSL nightly started failing in 9 of 15 runs, each time in one random version cell. The echo server showed the placeholder arriving untouched:

```
Echo: ALLOWED=kl::Xo;iV1RAmZLEHDdt17
```

The debug counters said everything upstream worked: placeholders matched, host policy passed. But H read zero at cipher init and the walk at write time never found it either. Every path concluded "not GCM" and quietly skipped the rewrite.

The flakiness was the confusing part. Same commit, same kernel: one night 3.2.6 failed, another night 3.3.7 or 4.0.1. The offsets were right, since other contexts read valid H at the same offset. The value just wasn't there.

Our first theory, in [issue #275](https://github.com/spinningfactory/kloak/issues/275): OpenSSL populates H **lazily**, and sometimes we read before it's written. The assumption was that this is a traditional race where our eBPF program would read the data before it was populated by OpenSSL.

## The fix we almost shipped

Attempting to compute H from round keys, similar to kloak's approach for BoringSSL, proved problematic. [PR #276](https://github.com/spinningfactory/kloak/pull/276) introduced this logic, but it triggered BPF verifier rejections due to stack size constraints from execution within a tail call context:

```
combined stack size of 2 calls is 640. Too large
```

Relocating the logic to a probe outside the tail call resolved the loading failure. However, the underlying assumption, that failures correlated directly with specific OpenSSL releases, was disproven by test run data showing inconsistent results across identical versions. Consequently, PR #276 was withdrawn to reevaluate the data and determine the actual cause of the failure.

## The root cause: it was the CPU

Counting gave us the first real clue. Over 100 runs, OpenSSL 3.0 passed 98 times and failed zero. 3.1 through 3.6 failed about 26% of the time. The flake wasn't random across versions: whatever it was, it arrived with 3.1.

So we diffed the last passing version against the first failing one and reviewed every change that touched GCM, key setup or the provider context. One stood out: a new x86 code path that OpenSSL only takes on certain CPUs.

Since 3.1, on CPUs with AVX-512 (Intel Ice Lake or newer, AMD Zen 4 or newer), OpenSSL runs GCM through a dedicated `vaes_gcm` path. 3.0 has none. And GitHub's hosted runners land on whatever Azure host is free, so some jobs got those CPUs and some didn't. We opened that code expecting to find a race. What we found was simpler, and worse: the path zeroes the GCM context and fills only its precomputed table of H powers. `GCM128_CONTEXT.H` is never written.

**H** wasn't lazy. On those machines it never existed in that field. The "flake" was a deterministic failure on one CPU family, sampled through a randomized runner pool.

**H** was still in memory, just in a different shape. Slot 15 of that table holds `HashKey_1`:

```
HashKey_1 = (bswap128(H) << 1) XOR (MSB ? POLY : 0)
```

That's H multiplied by x in GF(2¹²⁸), the same form Go's `gcmAesInit` stores. kloak already knew how to invert it.

![Flowchart of the OpenSSL x86 GCM key setup. Once a GCM cipher is keyed, OpenSSL checks for AVX-512 and VAES on OpenSSL 3.1 or later. Without them it takes the generic or AES-NI path, which writes GCM128_CONTEXT.H, and kloak reads raw H. With them it takes the vaes_gcm path, which never writes GCM128_CONTEXT.H and stores HashKey_1 in Htable[15]. Before #313 kloak read that context as not GCM and skipped the rewrite. Since #313 kloak inverts HashKey_1 with gf128_halve_to_h to recover H, on x86 only.](./openssl-gcm-key-setup.png)

*OpenSSL x86 GCM key setup · 2 paths*

Which path OpenSSL takes depends on the CPU, not the version alone, which is why the failures followed the runner.

## The fix: a few ALU ops instead of an AES engine

Undoing a multiplication by x is cheap. Bit 0 of the stored value says whether the polynomial reduction happened. Undo it, shift right, restore the top bit. No AES in BPF, no stack pressure, and the helper is now shared by the Go and OpenSSL paths.

Every OpenSSL read of H now goes through one function that:

1. **Gates on structure, not value.** A keyed GCM context's `gcm.key` points back at its own key schedule, and garbage in a context that isn't GCM can't fake that. This replaces "H ≠ 0 means GCM."
2. **Reads raw H first**, the fast path on the generic and AES-NI implementations.
3. **Falls back to inverting `HashKey_1` on x86 only.** On arm64, a zero H means an implementation we don't know, so kloak fails closed.

Inverting that slot is only correct if it still holds `HashKey_1` in exactly that form. So offset discovery checks OpenSSL's source against what the data plane assumes: the dispatch, the precompute sequence and its constants. If anything differs, it emits no offset and fails the build until a human looks. A wrong inversion means a wrong tag, and we'd rather fail CI than ship a guess.

## Proving it on the hardware that broke it

Rather than pin an AVX-512 runner, CI now logs each runner's CPU flags. The fix branch's [OpenSSL nightly](https://github.com/spinningfactory/kloak/actions/runs/37177900357) landed on both kinds:

| OpenSSL | Runner CPU | AVX-512 + VAES + VPCLMULQDQ | Result |
| :---- | :---- | :---- | :---- |
| 3.3.7 | Intel Xeon Platinum 8573C | yes | pass |
| 3.5.9 | Intel Xeon Platinum 8573C | yes | pass |
| 3.6.5 | AMD EPYC 9V45 | yes | pass |
| 3.0.22 | AMD EPYC 9V45 | yes (3.0 has no VAES path) | pass |
| 3.1.8, 3.2.6, 3.4.8 | AMD EPYC 7763 | no | pass |

On the first three rows raw H is always zero, so those rewrites could only succeed through `HashKey_1`. Before the fix, they failed every time.
