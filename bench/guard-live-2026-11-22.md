# live guard A/B — 2026-11-22

| task | file | arm | billed-in | whole-file reads | denies | faults | out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | src/page.mjs | baseline | 288421 | 0 | 0 | 0 | 2391 |
| T2 | src/store.mjs | baseline | 201356 | 0 | 0 | 0 | 2120 |
| T3 | src/extract.mjs | baseline | 651948 | 0 | 0 | 0 | 2652 |
| T1 | src/page.mjs | treatment | 295133 | 0 | 0 | 0 | 3544 |
| T2 | src/store.mjs | treatment | 545084 | 0 | 0 | 0 | 4423 |
| T3 | src/extract.mjs | treatment | 476067 | 0 | 0 | 0 | 3101 |
