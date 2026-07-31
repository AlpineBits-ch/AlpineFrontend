# HRIR sphere — attribution

`sadie_d1_48k.bin` is derived from the **SADIE II Database**, subject **D1** (Neumann KU100 dummy
head), 48 kHz / 24-bit head-related impulse responses.

> All SADIE data was recorded and developed at The Audio Lab, Department of Electronic Engineering,
> University of York, UK.
>
> Licensed under the Apache License, Version 2.0 (the "License"); you may not use this database
> except in compliance with the License. You may obtain a copy of the License at
> <http://www.apache.org/licenses/LICENSE-2.0>

Source: <https://www.york.ac.uk/sadie-project/database.html> (record:
<https://zenodo.org/records/10886409>, `D1.zip`).

## What was done to it

The measurements are distributed as WAV and SOFA. The `hrtf` crate reads neither — it wants a
triangulated sphere mesh in its own binary layout. `../../tools/hrir_sphere.rs` performs that
conversion; nothing is resampled, filtered or otherwise altered, so the impulse responses in this
file are SADIE's own samples. It is regenerated with:

```text
rustc -O --edition 2021 src-tauri/tools/hrir_sphere.rs -o hrir_sphere
./hrir_sphere <D1>/D1_HRIR_WAV/48K_24bit src-tauri/assets/hrir/sadie_d1_48k.bin
```

Apache 2.0 is a permissive licence: commercial use and redistribution are allowed, which is why
this ships in the repository rather than being downloaded at runtime the way OpenH264 must be.
