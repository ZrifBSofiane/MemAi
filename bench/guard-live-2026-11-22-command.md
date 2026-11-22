# live guard A/B [command] — 2026-11-22

| task | file | arm | billed-in | whole-file reads | denies | faults | out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | src/page.mjs | baseline | 132949 | 1 | 0 | 0 | 2035 |
| C2 | src/store.mjs | baseline | 203071 | 1 | 0 | 0 | 3276 |
| C3 | src/extract.mjs | baseline | 129920 | 1 | 0 | 0 | 3445 |
| C1 | src/page.mjs | treatment | 330707 | 0 | 1 | 0 | 3293 |
| C2 | src/store.mjs | treatment | 207812 | 0 | 1 | 0 | 3565 |
| C3 | src/extract.mjs | treatment | 210352 | 0 | 1 | 0 | 4137 |
