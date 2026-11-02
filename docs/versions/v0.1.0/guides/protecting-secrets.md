# Protecting Secrets with Kloak

This guide walks you through protecting your first Kubernetes Secret with Kloak. By the end, your application will never see actual secret values -- it will only see harmless `kloak:…` placeholders. The real values are patched into the encrypted TLS traffic in-kernel by eBPF, after your application has handed the data to its TLS library.

## How It Works

When you label a Secret with `getkloak.io/enabled=true`, Kloak's SecretReconciler automatically:

1. Creates a **shadow secret** named `<original>-kloak` containing `kloak:` placeholder values (`kloak:` followed by random uppercase letters and digits)
2. Generates each placeholder at exactly the original value's byte length, so HTTP/1.1 rewrites keep the wire format valid (see the [HTTP/2 known issue](/guides/supported-runtimes#http-2))

Every 5 seconds the controller joins each enabled Secret with its shadow and syncs the placeholder-to-real-value pairs into the eBPF `secret_map`.

Your application mounts and reads the shadow secret -- it only ever sees the placeholders. When the application writes data over TLS, an eBPF uprobe on the TLS write function scans for the `kloak:` prefix and records the patch; after the TLS library encrypts the data, a tc program on the pod's network interface patches the real value into the ciphertext before the packet leaves the pod.

## Step 1: Label Your Secret

Start with a standard Kubernetes Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-credentials
  labels:
    getkloak.io/enabled: "true"        # Enable Kloak protection (must be a label)
    getkloak.io/hosts: "api.stripe.com" # Optional: restrict to one host (a label in this release)
type: Opaque
data:
  api-key: c2stbGl2ZS1rZXktMTIzNDU2Nzg5MA==  # sk-live-key-1234567890
```

Apply it:

```bash
kubectl apply -f secret.yaml -n my-app
```

Within seconds, Kloak creates a shadow secret:

```bash
$ kubectl get secrets -n my-app
NAME                   TYPE     DATA   AGE
api-credentials        Opaque   1      5s
api-credentials-kloak  Opaque   1      5s
```

Inspect the shadow secret to see the placeholder:

```bash
$ kubectl get secret api-credentials-kloak -n my-app -o jsonpath='{.data.api-key}' | base64 -d
kloak:W9Z10682T52PDSJ9
```

The placeholder has the same length (22 bytes) as `sk-live-key-1234567890`. Yours will contain different random characters.

::: tip
The shadow secret has an `OwnerReference` pointing to the original and is labeled `getkloak.io/managed=true`. If you delete the original secret, Kubernetes garbage collection automatically cleans up the shadow.
:::

::: warning
Each secret value must be 8 -- 128 bytes long (`kloak:` plus at least 2 characters for the eBPF lookup key). Nothing checks this at admission in this release: a Secret with any value shorter than 8 bytes gets no shadow at all, so pods that mount it are rejected, and values longer than 128 bytes are truncated, so the rewrite is wrong.
:::

## Step 2: Enable Kloak on Your Pod

Kloak needs to know which pods should be mutated and have eBPF uprobes attached. You have two options:

### Option A: Pod Label

Add the label to the pod template. If the pod has the label, its value decides: `"false"` opts a pod out even in an enabled namespace.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
        getkloak.io/enabled: "true"
    spec:
      containers:
        - name: app
          image: my-app:latest
          volumeMounts:
            - name: api-creds
              mountPath: /etc/secrets/api
              readOnly: true
      volumes:
        - name: api-creds
          secret:
            secretName: api-credentials  # Reference the ORIGINAL secret name
```

::: warning
Only the pod **label** enables Kloak. A `getkloak.io/enabled` pod annotation does not, and there is no inheritance from Deployments or other workloads -- set the label on the pod template.
:::

### Option B: Namespace Label (Enables All Pods in Namespace)

```bash
kubectl label namespace my-app getkloak.io/enabled=true
```

When a namespace is labeled, every pod created in that namespace is automatically processed by Kloak -- no per-pod labels needed, unless a pod opts out with `getkloak.io/enabled: "false"`.

::: tip
Always reference the **original** secret name in your pod spec, not the shadow. The webhook automatically rewrites the reference to the shadow secret instead.
:::

## Step 3: How the Webhook Mutates Your Pod

When a pod with the `getkloak.io/enabled=true` label (or in a labeled namespace) is created, the Kloak mutating webhook intercepts the admission request and:

1. Checks if Kloak is enabled (pod label, otherwise namespace label)
2. Finds every `volumes[].secret` that references a Secret labeled `getkloak.io/enabled=true`
3. Rewrites each one from `api-credentials` to `api-credentials-kloak`
4. **Rejects** the pod if a shadow secret is missing or is not a Kloak-managed shadow (fail-closed -- prevents real secrets from being mounted)
5. Adds the `getkloak.io/enabled: "true"` annotation to the pod (so the controller can detect it)

::: danger Only secret volumes are rewritten
Environment variables (`env[].valueFrom.secretKeyRef`, `envFrom[].secretRef`) and `projected` volume sources are **not** rewritten in this release: a pod that reads a protected secret through them gets the real value. Mount protected secrets as `secret` volumes.
:::

You can verify the mutation worked:

```bash
# Check the pod annotation (injected by webhook on mutation)
$ kubectl get pod -l app=my-app -n my-app -o jsonpath='{.items[0].metadata.annotations.getkloak\.io/enabled}'
true

# Check which secret is actually mounted
$ kubectl get pod -l app=my-app -n my-app -o jsonpath='{.items[0].spec.volumes[0].secret.secretName}'
api-credentials-kloak
```

## Step 4: Verify the eBPF Rewrite

The best way to verify Kloak is working is to send a request to an echo service like [httpbin.org](https://httpbin.org) that reflects your headers back:

### Create the Secret

```bash
kubectl create secret generic api-credentials \
    --from-literal=api-key="sk-live-key-1234567890" \
    -n my-app --dry-run=client -o yaml | \
    kubectl label -f - getkloak.io/enabled="true" --local -o yaml | \
    kubectl label -f - getkloak.io/hosts="httpbin.org" --local -o yaml | \
    kubectl apply -f -
```

### Deploy a Test App

The test app forces HTTP/1.1 because of the [HTTP/2 known issue](/guides/supported-runtimes#http-2) in this release.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: curl-test
  namespace: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: curl-test
  template:
    metadata:
      labels:
        app: curl-test
        getkloak.io/enabled: "true"
    spec:
      containers:
        - name: curl
          image: curlimages/curl:latest
          command: ["sh", "-c"]
          args:
            - |
              while true; do
                SECRET=$(cat /etc/secrets/api/api-key)
                echo "App sees: $SECRET"
                echo "---"
                curl -s --http1.1 https://httpbin.org/headers \
                  -H "X-Api-Key: $SECRET"
                echo "---"
                sleep 10
              done
          volumeMounts:
            - name: api-creds
              mountPath: /etc/secrets/api
              readOnly: true
      volumes:
        - name: api-creds
          secret:
            secretName: api-credentials
```

### Check the Logs

```bash
kubectl logs -l app=curl-test -n my-app
```

You should see output like:

```
App sees: kloak:W9Z10682T52PDSJ9
---
{
  "headers": {
    "Host": "httpbin.org",
    "X-Api-Key": "sk-live-key-1234567890"
  }
}
---
```

The application reads `kloak:W9Z10682T52PDSJ9` from the mounted secret, but httpbin.org receives `sk-live-key-1234567890` -- the real value was patched into the encrypted traffic in-kernel.

::: danger
If you see the `kloak:` placeholder in the httpbin response, the eBPF rewrite did not trigger. Common causes:
- The controller pod is not running or not ready on the node
- The node's kernel is older than 6.6, so the tc patch program could not attach (the controller logs `Failed to attach tc egress to container`)
- The eBPF map has not synced yet (wait 10-15 seconds after pod startup)
- The connection negotiated a non-AES-GCM cipher suite (e.g. ChaCha20-Poly1305)
- The application's TLS library or version is not supported, or is affected by a known issue (see [Supported Runtimes](/guides/supported-runtimes))
- The DNS resolution for the target host was not captured (check controller logs for DNS debug counters)
:::

## What Happens Under the Hood

Here is the complete lifecycle of a protected secret:

```
1. You create Secret with label getkloak.io/enabled=true
   │
2. SecretReconciler creates shadow secret (api-credentials-kloak)
   │  Each value: "kloak:" + random uppercase letters and digits,
   │  same byte length as the original
   │
3. Controller syncs placeholder → real value + host/port filter
   │  into the eBPF secret_map (every 5 seconds)
   │
4. Pod is created referencing the original secret
   │
5. Webhook intercepts admission, rewrites reference: api-credentials → api-credentials-kloak
   │
6. Pod starts, reads shadow secret → sees "kloak:W9Z10682T52PDSJ9"
   │
7. Controller detects pod, finds PID via cgroup, attaches eBPF uprobes
   │
8. App calls SSL_write() / tls.Conn.Write() with data containing "kloak:..."
   │
9. eBPF uprobe fires (plaintext buffer is never modified):
   ├─ Phase 1: Scans the write buffer for "kloak:" (or its HPACK Huffman form)
   │           and records the 8-byte lookup keys
   └─ Phase 2 (tail call): Looks up each key, checks the host/port filter,
              computes an XOR delta (placeholder XOR real value)
   │
10. TLS library encrypts the placeholder; a tc program on the pod's eth0
    XORs the delta into the AES-GCM ciphertext and recomputes the GCM tag
    └─ The application process never had access to the real value
```

## Updating Secrets

When you update the original secret, Kloak automatically:

1. Detects the change via the SecretReconciler watch
2. Keeps the existing placeholder when the new value has the same byte length
3. Generates new placeholders for new keys or values whose length changed
4. Updates the shadow secret
5. Syncs the new mappings to the eBPF map (within 5 seconds)

No pod restart is required -- the eBPF map is updated live.

::: tip
Your application does not see a "change" in the mounted file unless a key is added or removed, or a value's byte length changes.
:::

## Cleaning Up

To stop protecting a secret, remove the label:

```bash
kubectl label secret api-credentials getkloak.io/enabled- -n my-app
```

The SecretReconciler will automatically delete the shadow secret, and the next sync removes its entries from the eBPF map. Running pods will continue to see the old placeholder values (which are no longer rewritten) until restarted.
