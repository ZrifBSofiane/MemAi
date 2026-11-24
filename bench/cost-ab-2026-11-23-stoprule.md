# live cost A/B [stoprule] — 2026-11-23

| task | arm | billed-in | turns | local CLI | correct |
| --- | --- | ---: | ---: | ---: | --- |
| S1 | baseline | 363778 | 1 | 4 | yes |
| S2 | baseline | 372676 | 1 | 4 | yes |
| S1 | treatment | 375229 | 1 | 3 | yes |
| S2 | treatment | 553041 | 1 | 5 | yes |

FAIL: S1: treatment 375229 > baseline 363778 (+1% tolerance); S2: treatment 553041 > baseline 372676 (+1% tolerance); total 928270 >= baseline 736454
