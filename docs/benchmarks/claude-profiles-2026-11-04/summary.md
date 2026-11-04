# Profile benchmark

Cells show median [minimum, maximum]. Warm-ups are excluded. Missing metrics retain their sample counts in results.json.

full-controlled uses the full prompt/tool presets with settings and client composition normalized to coding. It is not the native production full profile.

## claude-sonnet-4-6

| Variant | Acceptance | Input | Cached reads | Cache writes | Output | Model steps | Tool calls | Seconds | SDK estimated USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full-controlled | 5/5 attempted; 5 planned | 115042.000 [113500.000, 139449.000] | 107363.000 [106526.000, 129949.000] | 7739.000 [6967.000, 9492.000] | 5722.000 [4961.000, 7526.000] | 5.000 [5.000, 6.000] | 6.000 [6.000, 7.000] | 69.745 [62.295, 99.128] | 0.165 [0.148, 0.209] |
| full-restricted | 5/5 attempted; 5 planned | 88105.000 [84947.000, 117063.000] | 76413.000 [63777.000, 108008.000] | 11685.000 [9044.000, 21163.000] | 7053.000 [1344.000, 13314.000] | 5.000 [5.000, 7.000] | 6.000 [6.000, 7.000] | 107.116 [79.650, 160.053] | 0.220 [0.107, 0.324] |
| lean-full | 5/5 attempted; 5 planned | 99568.000 [95998.000, 160851.000] | 89119.000 [87334.000, 145948.000] | 10442.000 [8657.000, 14894.000] | 8632.000 [6865.000, 12332.000] | 5.000 [5.000, 7.000] | 6.000 [6.000, 8.000] | 105.078 [81.593, 153.482] | 0.219 [0.181, 0.310] |
| coding | 5/5 attempted; 5 planned | 72629.000 [69468.000, 88516.000] | 64620.000 [57823.000, 72078.000] | 11638.000 [8001.000, 16429.000] | 7427.000 [5671.000, 9423.000] | 6.000 [5.000, 7.000] | 7.000 [6.000, 7.000] | 93.964 [67.388, 115.341] | 0.210 [0.153, 0.231] |

## claude-sonnet-5-5

| Variant | Acceptance | Input | Cached reads | Cache writes | Output | Model steps | Tool calls | Seconds | SDK estimated USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full-controlled | 5/5 attempted; 5 planned | 77578.000 [57819.000, 77676.000] | 70777.000 [51238.000, 70777.000] | 6793.000 [6548.000, 6891.000] | 1137.000 [1052.000, 1369.000] | 4.000 [3.000, 4.000] | 3.000 [2.000, 3.000] | 18.794 [14.429, 25.302] | 0.045 [0.043, 0.046] |
| full-restricted | 5/5 attempted; 5 planned | 49353.000 [36488.000, 76014.000] | 44009.000 [31509.000, 70418.000] | 5336.000 [4973.000, 5584.000] | 1055.000 [950.000, 1395.000] | 4.000 [3.000, 6.000] | 3.000 [2.000, 5.000] | 19.624 [9.900, 23.290] | 0.036 [0.034, 0.043] |
| lean-full | 4/5 attempted; 5 planned | 49613.500 [49568.000, 49680.000] | 43103.000 [43103.000, 43103.000] | 6504.500 [6459.000, 6571.000] | 1174.000 [1085.000, 1213.000] | 3.000 [3.000, 3.000] | 2.000 [2.000, 2.000] | 17.192 [16.752, 18.005] | 0.042 [0.041, 0.043] |
| coding | 4/5 attempted; 5 planned | 29203.500 [28579.000, 29488.000] | 23766.000 [23561.000, 23766.000] | 5431.500 [5012.000, 5716.000] | 1409.500 [1126.000, 1743.000] | 3.000 [3.000, 3.000] | 3.500 [2.000, 4.000] | 16.006 [12.208, 17.815] | 0.038 [0.034, 0.043] |

Incomplete blocks and failures are retained. No generalized quality/cost claim follows from a partial run. SDK dollar estimates cover its query pipeline; main-token list-price bounds and cache lifetimes are recorded separately.
