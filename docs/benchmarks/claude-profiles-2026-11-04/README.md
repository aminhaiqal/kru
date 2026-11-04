# Claude profile benchmark — 2026-11-04

**38 measured runs completed; all 38 passed the unchanged 26-test acceptance suite.** Two final Sonnet 5.5 attempts hit the Claude account five-hour limit. This is an incomplete planned 40-run dataset, not five completed pairs for every contrast. The limit message reported a reset at 01:50 Asia/Kuala_Lumpur; no retries were made after the series ended.

The task repairs the archived TypeScript duration parser: descending h/m/s/ms units, full-input validation and safe-integer handling. Exact source, task prompt, instructions, settings and tests are in [task.json](task.json). Requested and observed models were `claude-sonnet-4-6` and `claude-sonnet-5-5`. Bun 1.4.4 ran on macOS arm64; SDK version and run order are recorded in [plan.json](plan.json).

## Measured result

On Sonnet 4.6, coding used fewer input tokens but had higher median estimated cost and latency than full-controlled. On the four completed Sonnet 5.5 pairs, coding used fewer input tokens and was cheaper and faster. These results support keeping profile choice model-dependent and coding opt-in. This single parser task does not establish general coding quality or savings.

Cells below show median [minimum–maximum]. Input includes uncached input, cache writes and cache reads; cached reads are a subset of input. Output is additional. Warm-ups are excluded from these distributions. The sample count is the number with measured usage; quota failures are missing measurements, not acceptance-test failures.

### claude-sonnet-4-6

| Treatment | Measured / planned | Acceptance | Input tokens | Cached reads | Output tokens |
| --- | --- | --- | --- | --- | --- |
| full-controlled | 5/5 | 5/5 × 26/26 | 115,042 [113,500–139,449] | 107,363 [106,526–129,949] | 5,722 [4,961–7,526] |
| full-restricted | 5/5 | 5/5 × 26/26 | 88,105 [84,947–117,063] | 76,413 [63,777–108,008] | 7,053 [1,344–13,314] |
| lean-full | 5/5 | 5/5 × 26/26 | 99,568 [95,998–160,851] | 89,119 [87,334–145,948] | 8,632 [6,865–12,332] |
| coding | 5/5 | 5/5 × 26/26 | 72,629 [69,468–88,516] | 64,620 [57,823–72,078] | 7,427 [5,671–9,423] |

| Treatment | SDK estimated USD | Seconds | Model steps | Tool calls | Cache writes |
| --- | --- | --- | --- | --- | --- |
| full-controlled | 0.1646 [0.1483–0.2090] | 69.7 [62.3–99.1] | 5.0 [5.0–6.0] | 6.0 [6.0–7.0] | 7,739 [6,967–9,492] |
| full-restricted | 0.2198 [0.1070–0.3237] | 107.1 [79.7–160.1] | 5.0 [5.0–7.0] | 6.0 [6.0–7.0] | 11,685 [9,044–21,163] |
| lean-full | 0.2190 [0.1813–0.3101] | 105.1 [81.6–153.5] | 5.0 [5.0–7.0] | 6.0 [6.0–8.0] | 10,442 [8,657–14,894] |
| coding | 0.2099 [0.1526–0.2309] | 94.0 [67.4–115.3] | 6.0 [5.0–7.0] | 7.0 [6.0–7.0] | 11,638 [8,001–16,429] |

### claude-sonnet-5-5

| Treatment | Measured / planned | Acceptance | Input tokens | Cached reads | Output tokens |
| --- | --- | --- | --- | --- | --- |
| full-controlled | 5/5 | 5/5 × 26/26 | 77,578 [57,819–77,676] | 70,777 [51,238–70,777] | 1,137 [1,052–1,369] |
| full-restricted | 5/5 | 5/5 × 26/26 | 49,353 [36,488–76,014] | 44,009 [31,509–70,418] | 1,055 [950–1,395] |
| lean-full | 4/5 | 4/4 × 26/26 | 49,614 [49,568–49,680] | 43,103 [43,103–43,103] | 1,174 [1,085–1,213] |
| coding | 4/5 | 4/4 × 26/26 | 29,204 [28,579–29,488] | 23,766 [23,561–23,766] | 1,410 [1,126–1,743] |

| Treatment | SDK estimated USD | Seconds | Model steps | Tool calls | Cache writes |
| --- | --- | --- | --- | --- | --- |
| full-controlled | 0.0449 [0.0431–0.0460] | 18.8 [14.4–25.3] | 4.0 [3.0–4.0] | 3.0 [2.0–3.0] | 6,793 [6,548–6,891] |
| full-restricted | 0.0359 [0.0336–0.0435] | 19.6 [9.9–23.3] | 4.0 [3.0–6.0] | 3.0 [2.0–5.0] | 5,336 [4,973–5,584] |
| lean-full | 0.0421 [0.0410–0.0427] | 17.2 [16.8–18.0] | 3.0 [3.0–3.0] | 2.0 [2.0–2.0] | 6,504 [6,459–6,571] |
| coding | 0.0382 [0.0337–0.0427] | 16.0 [12.2–17.8] | 3.0 [3.0–3.0] | 3.5 [2.0–4.0] | 5,432 [5,012–5,716] |

## Paired comparison: coding relative to full-controlled

The following percentages are the median of within-block changes, **not** changes between the separate medians above. All ranges and tool-only/prompt-only contrasts are preserved in [paired-contrasts.json](paired-contrasts.json). Positive means coding used more or took longer.

| Model | Complete pairs | Input | Output | SDK estimated USD | Time |
| --- | --- | --- | --- | --- | --- |
| claude-sonnet-4-6 | 5 | -38.8% | +20.4% | +40.3% | +17.7% |
| claude-sonnet-5-5 | 4 | -56.0% | +14.9% | -13.5% | -25.2% |

The “more steps” hypothesis has limited support here: Sonnet 4.6 coding had a marginal median of 6 steps versus 5 for full-controlled, but the median paired step change was 0% (range 0–40%). Sonnet 5.5 coding used 3 steps in each completed sample, versus 3–4 for full-controlled. A universal “lean prompts cause more steps” claim would overstate these observations.

## Conditions and limitations

- Four treatments form a prompt/tool 2×2 design; five blocks alternate forward/reverse order. Settings sources, client composition, permissions, task and auto-memory policy are constant. Models ran sequentially, so cross-model latency differences are descriptive, not a randomized model comparison.
- `full-controlled` uses the full native prompt and tool presets with settings/context composition normalized to coding. It differs from the production `full` bundle and from the uncontrolled 2026-11-03 benchmark. Prompt/tool effects can be separated; settings/context effects cannot.
- Every fresh session has a READY-only warm-up, scoped to that turn, before the measured task. This is the chosen warm-cache protocol, not a cold-cache experiment. Cache hits and 1-hour write lifetimes were observed and recorded. External cache state remains uncontrolled.
- Latency covers the measured turn only. Startup, warm-up and shutdown are excluded; the previous benchmark used different timing boundaries.
- SDK dollar estimates cover its query pipeline. Main-agent token pricing is separately recorded per row. These are list-price estimates, not an invoice or incremental subscription charge. They exclude unsupported billing effects and should not be advertised as money actually charged.
- Sonnet 5.5 block-five lean-full failed at measured start after a completed warm-up; coding failed during warm-up. Both quota errors remain in the data. Four observations cannot satisfy the planned five-pair minimum for those contrasts. A later replication should use a new predeclared series rather than silently filling gaps under different cache/time conditions.

## Resource accounting and excluded attempt

The corrected series recorded **$4.901479** for completed measured turns and **$0.722695** for 39 warm-ups with final receipts. These warm-up costs include the completed warm-up preceding the quota failure.

An earlier attempt was stopped because its warm-up said not to solve the task that follows, potentially conflicting with measurement. The exclusion reason was recorded before analyzing performance. Its entire evidence is retained under [excluded-attempt/](excluded-attempt/), including a completed measured estimate of **$0.492766** and a recorded warm-up estimate of **$0.035867**. The interrupted in-flight warm-up has no final usage receipt, so its partial cost is unknown. The recorded subtotal across both attempts is **$6.152806**, plus any unreported partial usage. See [resource-accounting.json](resource-accounting.json).

## Evidence and audit

- [results.json](results.json): per-run normalized usage, cache lifetimes, model/step/tool counters, cost snapshots, replies, errors and summary distributions.
- [results.raw.json](results.raw.json): exact original runner output. Its top-level `incomplete` flag incorrectly counted attempted rows; the audited results change only that flag to `true` and add an audit annotation. Per-run evidence is unchanged. The runner now checks measurements and recognizes this five-hour-limit message.
- [summary.md](summary.md): original generated distributions, including missing-sample counts.
- [verification.json](verification.json): all 38 acceptance logs checked for 26 pass / 0 fail, fixture contents compared to the frozen task, saved implementations matched, served models checked and implementation snapshot hashes verified.
- Per-run directories: raw event stream, generated `src/duration.ts.txt` and saved `duration.ts.txt`, original fixtures, result and independent acceptance log. Process bookkeeping is excluded.
- [implementation/](implementation/): exact source snapshot used for execution; [environment.json](environment.json) contains its hashes and original dirty Git head. Subsequent quota/completeness fixes are not presented as the code that produced these raw records.

TypeScript evidence has a `.txt` suffix to keep archived fixtures out of automatic test discovery. [archive-paths.json](archive-paths.json) maps original paths to archived paths; file bytes and recorded source hashes are unchanged.
