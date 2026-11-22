# live cost A/B [payload] — 2026-11-22

| task | arm | billed-in | turns | local CLI | --text calls | correct |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| P1 | baseline | 453100 | 1 | 4 | 0 | yes |
| P2 | baseline | 284290 | 1 | 3 | 0 | yes |
| P3 | baseline | 118416 | 1 | 1 | 0 | yes |
| P1 | treatment | 537086 | 1 | 6 | 6 | yes |
| P2 | treatment | 364214 | 1 | 3 | 3 | yes |
| P3 | treatment | 119768 | 1 | 1 | 0 | yes |

FAIL: P1: treatment 537086 > baseline 453100; P2: treatment 364214 > baseline 284290; P3: treatment did not use --text; P3: treatment 119768 > baseline 118416; total 1021068 >= baseline 855806
