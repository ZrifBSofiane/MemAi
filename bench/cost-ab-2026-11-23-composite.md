# live cost A/B [composite] — 2026-11-23

| task | arm | billed-in | turns | local CLI | correct |
| --- | --- | ---: | ---: | ---: | --- |
| C1 | baseline | 1459696 | 1 | 13 | yes |
| C2 | baseline | 818401 | 1 | 12 | yes |
| C1 | treatment | 764310 | 1 | 7 | yes |
| C2 | treatment | 864533 | 1 | 11 | yes |

FAIL: C2: treatment 864533 > baseline 818401 (+1% tolerance)
