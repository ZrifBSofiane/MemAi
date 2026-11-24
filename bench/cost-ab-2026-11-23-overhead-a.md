# live cost A/B [overhead-a] — 2026-11-23

| task | arm | billed-in | turns | local CLI | correct |
| --- | --- | ---: | ---: | ---: | --- |
| O1 | baseline | 452396 | 1 | 0 | yes |
| O2 | baseline | 119767 | 1 | 0 | yes |
| O3 | baseline | 201889 | 1 | 0 | yes |
| O1 | treatment | 279371 | 1 | 0 | yes |
| O2 | treatment | 203404 | 1 | 0 | yes |
| O3 | treatment | 361043 | 1 | 0 | yes |

FAIL: O2: treatment 203404 > baseline 119767 (+1% tolerance); O3: treatment 361043 > baseline 201889 (+1% tolerance); total 843818 >= baseline 774052
