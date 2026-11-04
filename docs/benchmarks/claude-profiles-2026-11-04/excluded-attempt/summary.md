# Profile benchmark

Cells show median [minimum, maximum]. Warm-ups are excluded. Missing metrics retain their sample counts in results.json.

full-controlled uses the full prompt/tool presets with settings and client composition normalized to coding. It is not the native production full profile.

## claude-sonnet-4-6

| Variant | Acceptance | Input | Cached reads | Cache writes | Output | Model steps | Tool calls | Seconds | SDK estimated USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full-controlled | 1/1 attempted; 5 planned | 146525.000 [146525.000, 146525.000] | 123483.000 [123483.000, 123483.000] | 23035.000 [23035.000, 23035.000] | 21166.000 [21166.000, 21166.000] | 5.000 [5.000, 5.000] | 6.000 [6.000, 6.000] | 274.445 [274.445, 274.445] | 0.493 [0.493, 0.493] |
| full-restricted | 0/1 attempted; 5 planned | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| lean-full | 0/0 attempted; 5 planned | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| coding | 0/0 attempted; 5 planned | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

Incomplete blocks and failures are retained. No generalized quality/cost claim follows from a partial run. SDK dollar estimates cover its query pipeline; main-token list-price bounds and cache lifetimes are recorded separately.
