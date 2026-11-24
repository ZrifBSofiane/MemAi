# live cost A/B [overhead] — 2026-11-23

| task | arm | billed-in | turns | local CLI | correct |
| --- | --- | ---: | ---: | ---: | --- |
| O1 | baseline | 205529 | 1 | 0 | yes |
| O2 | baseline | 39269 | 1 | 0 | yes |
| O3 | baseline | 119324 | 1 | 0 | yes |
| O1 | treatment | 436508 | 1 | 0 | yes |
| O2 | treatment | 282172 | 1 | 0 | yes |
| O3 | treatment | 194665 | 1 | 0 | yes |

FAIL: O1: treatment 436508 > baseline 205529 (+1% tolerance); O2: treatment 282172 > baseline 39269 (+1% tolerance); O3: treatment 194665 > baseline 119324 (+1% tolerance); total 913345 >= baseline 364122
