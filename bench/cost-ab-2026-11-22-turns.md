# live cost A/B [turns] — 2026-11-22

| task | arm | billed-in | turns | local CLI | correct |
| --- | --- | ---: | ---: | ---: | --- |
| T1 | baseline | 118918 | 1 | 1 | no |
| T2 | baseline | 1062399 | 1 | 10 | yes |
| T3 | baseline | 118839 | 1 | 1 | no |
| T1 | treatment | 119029 | 1 | 1 | yes |
| T2 | treatment | 198205 | 1 | 2 | yes |
| T3 | treatment | 118131 | 1 | 1 | yes |

FAIL: T1: treatment 119029 > baseline 118918
