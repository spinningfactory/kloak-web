---
title: 'Chasing a Flake Into OpenSSL''s GCM Path'
description: 'A CI flake that turned out to be a deterministic failure on AVX-512 CPUs, and how kloak now recovers OpenSSL''s GCM hash subkey without running AES in BPF'
pubDate: 2026-10-21
author: 'Kloak Team'
tags: ['ebpf', 'tls', 'openssl', 'debugging']
---

kloak reads OpenSSL's internal structures at fixed offsets, and those offsets change from one release to the next. Until June 2026 our E2E tests only ran against whatever OpenSSL versions came with our demo images. In May a hardcoded offset that was only correct for OpenSSL 3.2 and later [quietly broke kloak for anyone on 3.0 or 3.1](https://github.com/spinningfactory/kloak/pull/222). We only noticed when we tried kloak on Ubuntu 24.04.

In June we added a nightly job. It builds OpenSSL from source for every release we track, checks our offsets against each build, and runs the E2E tests on all of them. Within a week it was failing in ways we couldn't explain, and it kept failing until October. Most nights one or two versions failed, with no obvious pattern to which ones. Each time, the server got the `kl::` placeholder instead of the real secret. Our first guess was a race condition.

It turned out the bug had been in kloak since April, when we first started patching secrets into OpenSSL's encrypted records. The nightly just happened to be the first thing that ran enough OpenSSL versions, on enough different machines, to trip over it.

Below is how we tracked it down, the fix we nearly shipped, and the one we actually shipped in [kloak#313](https://github.com/spinningfactory/kloak/pull/313). To follow it you need to know a bit about how kloak rewrites secrets inside encrypted traffic, so we'll start there.

## How kloak works

kloak treats the application itself as untrusted, so the app never sees a real secret. A mutating webhook swaps each Secret for a shadow copy that holds a random `kl::…` placeholder of the same length.

When the app writes to a TLS connection, an eBPF uprobe on the library's write function spots the placeholder and checks the destination against the secret's policy. If the destination is allowed, a tc program patches the real value into the encrypted record on its way out. The server on the other end decrypts the real secret, while the app, and anything else in the pod, only ever has the placeholder.

The catch is GCM's authentication tag. Change the ciphertext and the tag no longer matches. kloak can recompute the tag in the kernel, but only if it has the connection's hash subkey, **H**. Without H there's no valid tag, and without a valid tag kloak can't touch the payload. So everything in this post comes down to getting H.

### One integration per TLS stack

kloak doesn't terminate TLS. It hooks into each supported stack (OpenSSL, BoringSSL, Go crypto/tls and Bun) at the point where the keys and the plaintext live. That means no proxy, no changes to the trust store, and no fighting certificate pinning. The price is that we read internal structures at offsets that move between releases.

We handle that with automation. A discovery tool for each stack extracts the offsets for every release and architecture we support. Every night we rerun discovery and the full E2E suite against all tracked versions, and when upstream ships a new release, a bot opens a pull request to add it.

## Where kloak finds H

H is AES_K(0¹²⁸), the encryption of an all zero block under the connection's AES key. Every TLS library computes it during key setup, but each one keeps it somewhere different:

| Runtime | Where H lives | How kloak gets it |
| :---- | :---- | :---- |
| Go crypto/tls | Stored as H·2, not H | Read it and invert the doubling |
| BoringSSL / Bun | Not stored, only the AES key schedule | Recompute AES_K(0) in the kernel |
| OpenSSL 3.x | `GCM128_CONTEXT.H` in the provider context | Read it at a calibrated offset |

## A flake that moved around

In one stretch, 9 of 15 nightly runs failed, usually in a single version. The echo server showed the placeholder going through untouched:

```
Echo: ALLOWED=kl::Xo;iV1RAmZLEHDdt17
```

The debug counters said everything before the rewrite had worked. The placeholder matched and the host policy passed. But H read as zero at cipher init, and the walk at write time didn't find it either, so every path decided the connection wasn't GCM and quietly skipped the rewrite.

The randomness was what made it confusing. Same commit, same kernel, and one night 3.2.6 would fail, another night 3.3.7 or 4.0.1. The offsets were fine, because other contexts read a valid H at the same offset. The value just wasn't there.

In [issue #275](https://github.com/spinningfactory/kloak/issues/275) we guessed that OpenSSL fills in H **lazily**, and that our eBPF program was sometimes reading it before OpenSSL had written it.

## The fix we almost shipped

If we couldn't read H, we could compute it from the AES round keys, the way kloak already does for BoringSSL. [PR #276](https://github.com/spinningfactory/kloak/pull/276) did exactly that, and the BPF verifier rejected it. The code ran inside a tail call, and the extra stack pushed it over the limit:

```
combined stack size of 2 calls is 640. Too large
```

Moving the logic into a probe that wasn't tail called got it to load. By then, though, the test data no longer fit the theory behind the PR. #276 assumed that a failing OpenSSL release would fail every time, and the nightly kept showing the same version passing one night and failing the next. We closed the PR and went back to the data.

## It was the CPU

Counting failures is what finally gave us a lead. Over 100 runs, OpenSSL 3.0 passed 98 times and never failed. Every version from 3.1 to 3.6 failed about 26% of the time. So the failures weren't spread across all versions. Whatever this was, it started with 3.1.

We diffed the last passing version against the first failing one and went through every change that touched GCM, key setup or the provider context. One of them stood out, a new x86 code path that OpenSSL only uses on certain CPUs.

Since 3.1, OpenSSL runs GCM through a dedicated `vaes_gcm` path on CPUs with AVX-512 (Intel Ice Lake or newer, AMD Zen 4 or newer). 3.0 doesn't have it. GitHub's hosted runners land on whatever Azure machine is free, so some of our jobs got those CPUs and some didn't.

We went into that code expecting to find a race. Instead we found that the path zeroes the GCM context and then only fills in its table of precomputed powers of H. It never writes `GCM128_CONTEXT.H` at all.

So H was never lazy. On those machines the field was always zero, and the flake was really a deterministic failure on one family of CPUs that showed up at random because the runner pool is random.

H was still in memory, though, just stored differently. Slot 15 of that table holds `HashKey_1`:

```
HashKey_1 = (bswap128(H) << 1) XOR (MSB ? POLY : 0)
```

That's H multiplied by x in GF(2¹²⁸), which is the same form Go's `gcmAesInit` stores. kloak already knew how to undo it for Go.

![Flowchart of the OpenSSL x86 GCM key setup. Once a GCM cipher is keyed, OpenSSL checks for AVX-512 and VAES on OpenSSL 3.1 or later. Without them it takes the generic or AES-NI path, which writes GCM128_CONTEXT.H, and kloak reads raw H. With them it takes the vaes_gcm path, which never writes GCM128_CONTEXT.H and stores HashKey_1 in Htable[15]. Before #313 kloak read that context as not GCM and skipped the rewrite. Since #313 kloak inverts HashKey_1 with gf128_halve_to_h to recover H, on x86 only.](./openssl-gcm-key-setup.png)

*OpenSSL x86 GCM key setup · 2 paths*

Which path OpenSSL takes depends on the CPU and not just the version, and that's why the failures followed the runner.

## A few ALU ops instead of an AES engine

Undoing a multiplication by x is cheap. Bit 0 of the stored value tells you whether the polynomial reduction happened. Undo that, shift right, and put the top bit back. There's no AES in BPF and no extra stack, and the Go and OpenSSL paths now share the same helper.

Every OpenSSL read of H now goes through a single function:

1. **It checks the structure, not the value.** In a keyed GCM context, `gcm.key` points back at the context's own key schedule. Random bytes in a context that isn't GCM can't fake that. This replaces the old rule that a nonzero H meant GCM.
2. **It reads raw H first.** That's the fast path, and it's what the generic and AES-NI implementations use.
3. **It falls back to inverting `HashKey_1`, on x86 only.** On arm64 a zero H means an implementation we don't know about, so kloak fails closed.

Inverting that slot only works if it still holds `HashKey_1` in exactly that form. So offset discovery now checks OpenSSL's source against what our BPF code assumes: the dispatch logic, the precompute sequence and its constants. If anything has changed, discovery doesn't emit the offset, and CI stays red until someone looks at it. A wrong inversion gives a wrong tag, and we'd much rather have a failing build than ship a guess.

## Proving it on the hardware that broke it

We didn't pin an AVX-512 runner. CI now just logs each runner's CPU flags. The [OpenSSL nightly](https://github.com/spinningfactory/kloak/actions/runs/37177900357) on the fix branch happened to land on both kinds of machine:

| OpenSSL | Runner CPU | AVX-512 + VAES + VPCLMULQDQ | Result |
| :---- | :---- | :---- | :---- |
| 3.3.7 | Intel Xeon Platinum 8573C | yes | pass |
| 3.5.9 | Intel Xeon Platinum 8573C | yes | pass |
| 3.6.5 | AMD EPYC 9V45 | yes | pass |
| 3.0.22 | AMD EPYC 9V45 | yes (3.0 has no VAES path) | pass |
| 3.1.8, 3.2.6, 3.4.8 | AMD EPYC 7763 | no | pass |

On the first three rows raw H is always zero, so the only way those rewrites could pass was through `HashKey_1`. Before the fix they failed every time.
