## Additional notices

Obligations that no dependency scanner can derive, because the licence a package declares is not
the licence of everything it delivers. Each is written by hand and appended verbatim to the
generated file.

### Twemoji graphics — CC-BY-4.0

Copyright 2019 Twitter, Inc and other contributors.

This application displays Twemoji emoji artwork in two places: fetched from a CDN by
`src/app/components/twemoji/twemoji.component.ts`, and bundled directly into the build from the
`emoji-datasource-twitter` sprite sheet, which `angular.json` copies into `emoji-sheets/twitter`.

The `twemoji` and `emoji-datasource-twitter` packages both declare MIT, and MIT covers their code.
The **graphics are separately licensed under CC-BY-4.0** and require attribution, which this notice
provides. The full CC-BY-4.0 text is reproduced with the `twemoji` package below.

- Code: MIT
- Graphics: CC-BY-4.0 — <https://creativecommons.org/licenses/by/4.0/>

### Independent JPEG Group

The `jpeg-encoder` crate is licensed `(MIT OR Apache-2.0) AND IJG`. The conjunction is not a choice:
the IJG term applies in addition to whichever permissive licence is taken, and it requires the
following credit in the documentation of any software based on its work.

> This software is based in part on the work of the Independent JPEG Group.

### OpenH264 — Cisco Systems, Inc.

The `openh264` and `openh264-sys2` crates are BSD-2-Clause and their notices appear below with the
other Rust crates.

The H.264 codec binary itself is **not distributed with this application**. It is downloaded from
Cisco at runtime by `src-tauri/src/media/publisher/openh264_blob.rs` and loaded dynamically.

This is deliberate and load-bearing. OpenH264's source licence grants copyright rights but not
patent rights, so a binary compiled from source would owe AVC patent royalties. Cisco pays those
royalties only for the binary modules they themselves compile and distribute — a copy redistributed
by someone else is no longer the copy Cisco licensed. Fetching their binary at runtime keeps this
application downstream of a licence that has already been paid for.

Cisco's binary is governed by Cisco's own licence terms, available at
<https://www.openh264.org/BINARY_LICENSE.txt>.
