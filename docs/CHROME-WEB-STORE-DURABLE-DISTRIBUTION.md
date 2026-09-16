# Chrome Web Store durable distribution

Canonical work: DevelopmentInfrastructure #443 (`chatgpt-notifier-reboot-registration-persistence-2026-09-16`).

## Why this exists

The notifier's helper/update architecture is durable across Windows restarts, but a one-time manual **Load unpacked** registration is not a supported production installation channel and proved non-durable after a normal Windows Update reboot. The extension files, stable unpacked root, helper startup registration, and protected Chrome preference entry survived while Chrome no longer exposed a live notifier runtime.

Do not repair that failure by editing Chrome `Preferences` / `Secure Preferences`, by recurring CDP `loadUnpacked`, or by reintroducing native foreground/window control. The production browser-install boundary moves to Chrome Web Store distribution; the localhost helper, notification ownership, bounded recovery, and protected Glass deployment remain unchanged.

## Distribution choice

Use an **Unlisted** Chrome Web Store item for the Glass deployment. Unlisted items are not searchable/listed, but the installation URL can be used directly. Store review and policy requirements still apply.

Normal Chrome Web Store uploads do **not** require a repository/private signing key. Chrome Web Store signs published extensions automatically. Do not enable Verified CRX Uploads as part of this migration unless a separate reviewed key-management design is adopted.

## Identity model

Current development/unpacked identity before Store binding:

- extension ID: `lciedmoiiapbgemklkpoadimhffaaaah`
- source of identity: `extension/manifest.json` public `key`
- helper allowlist: the same extension origin in `LocalBridgeConstants`

Chrome's documented consistent-ID flow assigns a public key/Item ID when the package is uploaded to the Developer Dashboard. Development source then adopts that Store-assigned public key so unpacked development builds and the Store build share one identity.

Therefore the migration is intentionally two phase:

1. **Seed:** build/upload a Store ZIP whose package manifest omits the current development-only `key`. The source manifest is not modified. Chrome Web Store assigns the new item identity.
2. **Bind:** record the Store Item ID and public key, atomically update all source/helper identity surfaces, and build only `Bound` packages afterward.

Do not guess, reconstruct, or synthesize the Store public key. Do not try to preserve the current unpacked ID by inventing a private key. If the Store happens to assign the same public key/ID, the binding tool will prove it; otherwise the migration is explicit and reviewed.

## Repository tools

### Build the first Store seed package

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Build-ChromeWebStorePackage.ps1 `
  -IdentityMode Seed `
  -OutputPath .\artifacts\chatgpt-response-notifier-cws-seed.zip
```

The builder:

- refuses extension source containing any `.pem` file;
- copies only the extension runtime into an isolated temporary package workspace;
- removes `manifest.key` from **Seed** packages only;
- adds deterministic 16/32/48/128 PNG extension icons to the Store package;
- adds matching manifest/action icon mappings;
- leaves all non-manifest source files byte-identical;
- emits the package SHA-256 and deletes the temporary workspace.

### Bind the Store-assigned identity

After the seed ZIP has been uploaded in the Chrome Web Store Developer Dashboard, obtain both the **Item ID** and the **public key** from the Package tab. Then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Set-ChromeWebStoreIdentity.ps1 `
  -ItemId '<32-character-store-item-id>' `
  -PublicKey '<base64-public-key>'
```

The binding tool derives the Chrome extension ID from the supplied public key and refuses to continue unless it exactly matches the supplied Item ID. It then updates the extension manifest, helper origin/ID constants, identity regression test, and `store/chrome-web-store.identity.json` as one reviewable source change. Rebinding an existing Store identity fails closed unless an explicit reviewed migration requests `-ReplaceExistingBinding`.

### Build bound packages

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Build-ChromeWebStorePackage.ps1 `
  -IdentityMode Bound `
  -OutputPath .\artifacts\chatgpt-response-notifier-cws.zip
```

Bound mode refuses to build unless Store identity metadata exists and the manifest public key, derived extension ID, and Store Item ID all agree.

## Human boundary for #443

All non-interactive source preparation should be completed before asking for operator action. The first genuinely interactive boundary is the authenticated Chrome Web Store Developer Dashboard:

1. Sign in with the Google account that will own the notifier item.
2. If required, finish Chrome Web Store developer registration / account prerequisites.
3. Click **Add new item** and upload the validated `Seed` ZIP from the exact-head workflow artifact.
4. Open the new item's **Package** tab.
5. Copy the assigned **Item ID** and **View public key** value back to the working chat. The public key is public identity material; never provide a private key, OAuth token, password, recovery code, or other account secret.

Stop there. Do not publish or install the Seed package. Source must first be bound to the Store identity, rebuilt, validated, released, and the helper identity cut over coherently.

## Publication/acceptance gates after identity binding

Before first unlisted publication:

- exact-head normal validation passes;
- exact-head Chrome Web Store package validation passes in `Bound` mode;
- runtime package contains the required 128×128 PNG icon and no private key material;
- Store listing and Privacy practices accurately describe the current permissions and single purpose;
- at least one current UI screenshot and required Store listing graphics are supplied in the Developer Dashboard;
- helper/release source is built with the Store-assigned extension origin;
- protected Glass deployment proves the helper/version/rollback state;
- the **Bound** package is uploaded and the item is set to **Unlisted**;
- the Store-installed extension is installed on Glass and is the live runtime;
- one normal reboot/login proves the Store extension remains installed/live and reconnects to the localhost helper without manual `Load unpacked`;
- #442 cross-Windows-virtual-desktop toast-click acceptance is rerun only after this durable runtime gate passes.

## Store listing facts to preserve

The extension's single purpose is to monitor already-open ChatGPT conversations for notifier-eligible completion/status events, show persistent Windows notifications through the localhost helper, and perform only the bounded/reviewed recovery/continuation actions implemented in source. It must not be described as a general ChatGPT API client.

Permission/privacy declarations must remain implementation-specific. In particular:

- `tabs` is used for conversation/tab identity and physical toast-click routing;
- `scripting` is used to initialize/update notifier scripts in eligible ChatGPT tabs;
- `webRequest` observes request lifecycle/status evidence for the page's own traffic and does not issue a second ChatGPT request;
- `alarms` supports extension-owned scheduled/recovery work;
- `https://chatgpt.com/*` scopes page monitoring/injection to ChatGPT;
- `ws://127.0.0.1/*` is loopback-only transport to the installed Windows helper.

Before publication, re-audit these statements against the exact bound release rather than copying stale listing text forward.
