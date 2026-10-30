# Security policy

## Supported versions

Security fixes go into the next release; there are no fixes for earlier versions. Please reproduce a problem with the [latest release](https://github.com/jason-bot-147/lettrine/releases/latest), or a build of the latest commit on `main`, before reporting it.

Releases are ad-hoc signed with the hardened runtime and aren't notarized. Download them only from the repository's Releases page and check them against the release's `SHA256SUMS`, as the [installation steps](README.md#install) explain.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/jason-bot-147/lettrine/security/advisories/new): the **Report a vulnerability** button on the repository's Security tab. Please don't describe an unfixed vulnerability in a public issue or pull request.

Include the Lettrine version (or the commit you built), your macOS version, the steps to reproduce, the impact you expect, and the smallest document or file that shows the problem. Remove anything personal from samples. Maintainers will acknowledge and investigate privately, coordinate a fix and its disclosure with you, and credit you if you'd like. This volunteer project can't promise a fixed response or release time.

## Scope

Lettrine opens documents from anywhere, so it treats documents, file names and pasted content as untrusted. Raw HTML in a document is shown as text, the native bridge accepts messages only from the app's own page, and the `lettrine://` scheme serves only the app's resources and files in folders you've opened. Reports like these are in scope:

- A document, file name or pasted content that runs script in the page or sends messages to the native host.
- Reading or writing files outside your documents, the folders you opened and Lettrine's data folder.
- A document that changes settings, runs an image-upload command or contacts a service you didn't set up.
- Network requests that the [Privacy](README.md#privacy) section says don't happen.
